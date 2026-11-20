import type { ExecRequest, ExecResult, ExecStopped } from './environment.js';
import { ProcessNotStarted, type Named, type Streams } from './processes.js';

export const STOP_GRACE_MS = 5_000;

export const NOT_FOUND_EXIT = 127;
export const STOPPED_EXIT = 124;

export interface ModelShell {
  streams: Streams;
  shell: readonly string[];
  cwd: string;
  env?: Named | undefined;
  graceMs?: number | undefined;
}

export function execForModel(shell: ModelShell, request: ExecRequest): Promise<ExecResult> {
  const [program, ...flags] = shell.shell;
  if (!program) throw new Error('a model exec needs a shell to run its command in');
  if (request.signal?.aborted) return Promise.resolve({ stdout: '', stderr: '', exitCode: STOPPED_EXIT, stopped: 'cancelled' });
  let stdout = '';
  let stderr = '';
  const running = shell.streams.start(
    { command: program, args: [...flags, request.command], cwd: request.cwd ?? shell.cwd, env: { ...shell.env, ...request.env } },
    { group: true, heard: { stdout: (chunk) => { stdout += chunk; }, stderr: (chunk) => { stderr += chunk; } } },
  );
  let stopped: ExecStopped | undefined;
  let settled = false;
  const timers: NodeJS.Timeout[] = [];
  const stop = (why: ExecStopped): void => {
    if (stopped || settled) return;
    stopped = why;
    running.stop('SIGTERM');
    const escalation = setTimeout(() => { if (!settled) running.stop('SIGKILL'); }, shell.graceMs ?? STOP_GRACE_MS);
    escalation.unref();
    timers.push(escalation);
  };
  if (request.timeoutMs !== undefined) timers.push(setTimeout(() => stop('timeout'), request.timeoutMs));
  const onAbort = (): void => stop('cancelled');
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const finished = (result: ExecResult): ExecResult => {
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    request.signal?.removeEventListener('abort', onAbort);
    return stopped ? { ...result, stopped } : result;
  };
  return running.ended.then(
    (result) => finished({ stdout, stderr, exitCode: result.signal !== undefined && stopped ? STOPPED_EXIT : result.code }),
    (err: unknown) => {
      if (!(err instanceof ProcessNotStarted)) throw err;
      return finished({ stdout, stderr: `${stderr}\n${err.message}`.trim(), exitCode: NOT_FOUND_EXIT });
    },
  );
}
