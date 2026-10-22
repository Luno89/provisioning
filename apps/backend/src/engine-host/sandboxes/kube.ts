import { spawn } from 'child_process';
import { WORKSPACE_STAMP } from '../../engine/lib/published-workspace.js';
import { assessWorkload } from '../../infrastructure/lib/workload-health.js';
import { createReadStream, createWriteStream } from 'fs';
import path from 'path';

export interface KubeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stopped?: 'timeout' | 'cancelled' | undefined;
}

export interface KubeRunOptions {
  outputChars?: number | undefined;
  signal?: AbortSignal | undefined;
  onStop?: ((why: 'timeout' | 'cancelled') => Promise<void>) | undefined;
}

export interface KubeRunner {
  (args: string[], input?: string, timeoutMs?: number, options?: KubeRunOptions): Promise<KubeResult>;
}

export interface KubeStreamer {
  toFile(args: string[], destination: string, timeoutMs?: number): Promise<{ exitCode: number; stderr: string }>;
  fromFile(args: string[], source: string, timeoutMs?: number): Promise<{ exitCode: number; stderr: string }>;
}

export const MAX_OUTPUT_CHARS = 30_000;

const kubectlAt = (binDir?: string): string => path.join(binDir ?? path.join(process.cwd(), '..', '..', 'bin'), 'kubectl');

export function createKubeStreamer(options: { binDir?: string; kubeconfig?: string | undefined } = {}): KubeStreamer {
  const binary = kubectlAt(options.binDir);

  const spawnWith = (
    args: string[],
    timeoutMs: number | undefined,
    wire: (child: ReturnType<typeof spawn>) => (done: () => void) => void,
  ) => new Promise<{ exitCode: number; stderr: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...(options.kubeconfig ? { KUBECONFIG: options.kubeconfig } : {}) },
    });
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : undefined;
    const finish = wire(child);

    child.stderr!.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      finish(() => resolve({ exitCode: code ?? -1, stderr: stderr.slice(0, MAX_OUTPUT_CHARS) }));
    });
  });

  return {
    toFile: (args, destination, timeoutMs) => spawnWith(args, timeoutMs, (child) => {
      const out = createWriteStream(destination);
      child.stdout!.pipe(out);
      child.stdin!.end();
      return (done) => out.end(done);
    }),

    fromFile: (args, source, timeoutMs) => spawnWith(args, timeoutMs, (child) => {
      child.stdout!.resume();
      createReadStream(source).pipe(child.stdin!);
      return (done) => done();
    }),
  };
}

export function createKubeRunner(options: { binDir?: string; kubeconfig?: string | undefined } = {}): KubeRunner {
  const binary = kubectlAt(options.binDir);

  return (args, input, timeoutMs, runOptions = {}) => new Promise<KubeResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...(options.kubeconfig ? { KUBECONFIG: options.kubeconfig } : {}) },
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const outputChars = runOptions.outputChars ?? MAX_OUTPUT_CHARS;

    let stopped: 'timeout' | 'cancelled' | undefined;
    const stop = (why: 'timeout' | 'cancelled'): void => {
      if (stopped) return;
      stopped = why;
      const ended = runOptions.onStop ? runOptions.onStop(why).catch(() => undefined) : Promise.resolve();
      void ended.finally(() => child.kill('SIGKILL'));
    };
    const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : undefined;
    const onAbort = (): void => stop('cancelled');
    if (runOptions.signal?.aborted) onAbort();
    else runOptions.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (): void => {
      if (timer) clearTimeout(timer);
      runOptions.signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => { stdout.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
    child.on('error', (err) => { settle(); reject(err); });
    child.on('close', (code) => {
      settle();
      resolve({
        stdout: Buffer.concat(stdout).toString().slice(0, outputChars),
        stderr: Buffer.concat(stderr).toString().slice(0, MAX_OUTPUT_CHARS),
        exitCode: code ?? -1,
        ...(stopped ? { stopped } : {}),
      });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export interface ApplyRequest {
  manifests: Record<string, unknown>[];
  namespace: string;
  pod: string;
  pollMs?: number | undefined;
}

export class WorkspaceUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'WorkspaceUnavailableError';
  }
}

const podOf = (text: string): { status?: { phase?: string } } | undefined => {
  try {
    return JSON.parse(text) as { status?: { phase?: string } };
  } catch {
    return undefined;
  }
};

export async function applyWorkspace(run: KubeRunner, request: ApplyRequest): Promise<void> {
  const doc = request.manifests.map((manifest) => JSON.stringify(manifest)).join('\n---\n');
  let applied = await run(['apply', '-f', '-'], doc);
  for (let again = 0; again < 2 && applied.exitCode !== 0 && /AlreadyExists/.test(applied.stderr); again += 1) {
    applied = await run(['apply', '-f', '-'], doc);
  }

  if (applied.exitCode !== 0) {
    throw new WorkspaceUnavailableError(
      `Could not create the workspace for this run: ${applied.stderr || applied.stdout}`,
    );
  }

  for (;;) {
    const read = await run(['get', 'pod', request.pod, '-n', request.namespace, '-o', 'json'], undefined, undefined, { outputChars: Infinity });
    const pod = read.exitCode === 0 ? podOf(read.stdout) : undefined;
    if (pod) {
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        throw new WorkspaceUnavailableError(`The workspace stopped before it was ready: its pod is ${pod.status.phase}`);
      }
      const health = assessWorkload({ items: [pod] });
      if (health.health === 'healthy') return;
      if (health.health === 'unhealthy') throw new WorkspaceUnavailableError(`The workspace cannot start: ${health.reason}`);
    }
    await new Promise((settle) => setTimeout(settle, request.pollMs ?? 2_000));
  }
}

export async function destroyWorkspace(run: KubeRunner, namespace: string): Promise<void> {
  await run(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']);
}

export async function retirePod(run: KubeRunner, namespace: string, pod: string): Promise<void> {
  await run(['delete', 'pod', pod, '-n', namespace, '--ignore-not-found', '--wait=true']);
}

export async function workspaceStampOf(run: KubeRunner, namespace: string, pod: string): Promise<{ running: boolean; stamp?: string | undefined }> {
  const got = await run(
    ['get', 'pod', pod, '-n', namespace, '-o', `jsonpath={.status.phase}{"\\t"}{.metadata.annotations.${WORKSPACE_STAMP.replaceAll('.', '\\.')}}`],
  );
  if (got.exitCode !== 0) return { running: false };
  const [phase = '', stamp = ''] = got.stdout.trim().split('\t');
  return { running: phase === 'Running', ...(stamp ? { stamp } : {}) };
}

export async function workspaceRunning(run: KubeRunner, namespace: string, pod: string): Promise<boolean> {
  const got = await run(
    ['get', 'pod', pod, '-n', namespace, '-o', 'jsonpath={.status.phase}'],
  );

  return got.exitCode === 0 && got.stdout.trim() === 'Running';
}
