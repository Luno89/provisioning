import { spawn } from 'child_process';
import { clampDualBoundary, DEFAULT_COMPACTION_CONFIG } from '@koala/context-engine';

export const MAX_OUTPUT_CHARS = DEFAULT_COMPACTION_CONFIG.maxOutputChars;
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface DockerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface RunDockerOptions {
  stdin?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputChars?: number | undefined;
  headRatio?: number | undefined;
}

/** Mirrors `WorkspaceService.run()`'s exact shape (spawn, no shell, single timeout → SIGKILL). */
export function runDocker(args: string[], opts: RunDockerOptions = {}): Promise<DockerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxOutputChars ?? MAX_OUTPUT_CHARS;
  const headRatio = opts.headRatio ?? DEFAULT_COMPACTION_CONFIG.outputHeadRatio;

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
        stdout: clampDualBoundary(stdout, { maxChars, headRatio }),
        stderr: clampDualBoundary(stderr, { maxChars, headRatio }),
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
