import { spawn } from 'child_process';

export const MAX_OUTPUT_CHARS = 30_000;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/** Mirrors `WorkspaceService.run()`'s exact shape (spawn, no shell, single timeout → SIGKILL). */
export function runDocker(args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<DockerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
        stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
        exitCode: code ?? -1,
        timedOut,
      });
    });

    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

/** Mirrors `InfrastructureService.checkGpuToolkit()`'s "probe, catch, report actionable" idiom. */
export async function dockerAvailable(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const result = await runDocker(['info'], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return { ok: false, reason: 'Docker is installed but not running. Start Docker Desktop (or run \'colima start\') and reconnect.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'Docker is not installed on this machine. Install it, or leaves here will run as raw host commands instead.' };
  }
}
