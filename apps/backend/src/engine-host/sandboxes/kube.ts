import { spawn } from 'child_process';
import path from 'path';

export interface KubeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface KubeRunner {
  (args: string[], input?: string, timeoutMs?: number): Promise<KubeResult>;
}

export const MAX_OUTPUT_CHARS = 30_000;

export function createKubeRunner(options: { binDir?: string; kubeconfig?: string | undefined } = {}): KubeRunner {
  const binary = path.join(options.binDir ?? path.join(process.cwd(), '..', '..', 'bin'), 'kubectl');

  return (args, input, timeoutMs = 120_000) => new Promise<KubeResult>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...(options.kubeconfig ? { KUBECONFIG: options.kubeconfig } : {}) },
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: code ?? -1,
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
  readyTimeoutMs: number;
}

export class WorkspaceUnavailableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'WorkspaceUnavailableError';
  }
}

export async function applyWorkspace(run: KubeRunner, request: ApplyRequest): Promise<void> {
  const doc = request.manifests.map((manifest) => JSON.stringify(manifest)).join('\n---\n');
  const applied = await run(['apply', '-f', '-'], doc);

  if (applied.exitCode !== 0) {
    throw new WorkspaceUnavailableError(
      `Could not create the workspace for this run: ${applied.stderr || applied.stdout}`,
    );
  }

  const seconds = Math.ceil(request.readyTimeoutMs / 1000);
  const ready = await run(
    ['wait', '--for=condition=Ready', `pod/${request.pod}`, '-n', request.namespace, `--timeout=${seconds}s`],
    undefined,
    request.readyTimeoutMs + 10_000,
  );

  if (ready.exitCode !== 0) {
    throw new WorkspaceUnavailableError(
      `The workspace never became ready: ${ready.stderr || ready.stdout}`,
    );
  }
}

export async function destroyWorkspace(run: KubeRunner, namespace: string): Promise<void> {
  await run(['delete', 'namespace', namespace, '--ignore-not-found', '--wait=false']);
}

export async function retirePod(run: KubeRunner, namespace: string, pod: string): Promise<void> {
  await run(['delete', 'pod', pod, '-n', namespace, '--ignore-not-found', '--wait=true'], undefined, 60_000);
}

export async function workspaceRunning(run: KubeRunner, namespace: string, pod: string): Promise<boolean> {
  const got = await run(
    ['get', 'pod', pod, '-n', namespace, '-o', 'jsonpath={.status.phase}'],
    undefined,
    15_000,
  );

  return got.exitCode === 0 && got.stdout.trim() === 'Running';
}
