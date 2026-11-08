import { createReadStream, createWriteStream } from 'fs';
import { WORKSPACE_STAMP } from '../../engine/lib/published-workspace.js';
import { assessWorkload } from '../../infrastructure/lib/workload-health.js';
import type { Followed, Io } from '../../platform/index.js';

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
  toFile(args: string[], destination: string): Promise<{ exitCode: number; stderr: string }>;
  fromFile(args: string[], source: string): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ClusterStarter {
  start(clusterId: string, args: readonly string[], io?: Io): Promise<Followed>;
}

export interface KoalasCluster {
  start(args: readonly string[], io?: Io): Promise<Followed>;
}

export const onKoalasCluster = (access: ClusterStarter, clusterId: () => string): KoalasCluster => ({
  start: (args, io) => access.start(clusterId(), args, io),
});

export const MAX_OUTPUT_CHARS = 30_000;

export function createKubeStreamer(cluster: KoalasCluster): KubeStreamer {
  const ran = async (followed: Followed) => {
    const result = await followed.ended;
    return { exitCode: result.code, stderr: result.stderr.slice(0, MAX_OUTPUT_CHARS) };
  };
  return {
    toFile: async (args, destination) => {
      const output = createWriteStream(destination);
      const followed = await cluster.start(args, { output }).catch((err: unknown) => {
        output.destroy();
        throw err;
      });
      return ran(followed);
    },
    fromFile: async (args, source) => {
      const result = await (await cluster.start(args, { input: createReadStream(source) })).ended;
      return { exitCode: result.code, stdout: result.stdout.slice(0, MAX_OUTPUT_CHARS), stderr: result.stderr.slice(0, MAX_OUTPUT_CHARS) };
    },
  };
}

export function createKubeRunner(cluster: KoalasCluster): KubeRunner {
  return async (args, input, timeoutMs, runOptions = {}) => {
    const followed = await cluster.start(args, input === undefined ? {} : { input });
    const outputChars = runOptions.outputChars ?? MAX_OUTPUT_CHARS;

    let stopped: 'timeout' | 'cancelled' | undefined;
    const stop = (why: 'timeout' | 'cancelled'): void => {
      if (stopped) return;
      stopped = why;
      const ended = runOptions.onStop
        ? runOptions.onStop(why).catch((err: unknown) => {
          console.warn(`[kube] kubectl ${args[0] ?? ''} was stopped (${why}) but what it started could not be, so it may still run in its pod: ${(err as Error).message}`);
        })
        : Promise.resolve();
      void ended.finally(() => followed.stop());
    };
    const timer = timeoutMs ? setTimeout(() => stop('timeout'), timeoutMs) : undefined;
    const onAbort = (): void => stop('cancelled');
    if (runOptions.signal?.aborted) onAbort();
    else runOptions.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const result = await followed.ended;
      return {
        stdout: result.stdout.slice(0, outputChars),
        stderr: result.stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: result.code,
        ...(stopped ? { stopped } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      runOptions.signal?.removeEventListener('abort', onAbort);
    }
  };
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
