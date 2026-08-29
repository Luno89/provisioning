
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const ERROR_PATTERNS = [
  /\bError:/,
  /\bfailed calling webhook\b/i,
  /\bx509:/,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b/,
  /\berror\b.*\bexit code\b/i,
  /\bfailed\b/i,
];

const MAX_SUMMARY = 600;
const TAIL_LINES = 3;

export function salientFailure(stdout: string, stderr: string): string {
  const lines = [...stripAnsi(stderr).split('\n'), ...stripAnsi(stdout).split('\n')]
    .map((l) => l.replace(/^[\s|│╷╵]+/, '').trimEnd())
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return '';

  for (const pattern of ERROR_PATTERNS) {
    const hit = lines.filter((l) => pattern.test(l));
    if (hit.length > 0) return hit.join('\n').slice(0, MAX_SUMMARY);
  }
  return lines.slice(-TAIL_LINES).join('\n').slice(0, MAX_SUMMARY);
}

export class CommandFailedError extends Error {
  override readonly name = 'CommandFailedError';
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly logFile: string;

  constructor(command: string, exitCode: number | null, stdout: string, stderr: string, logFile: string) {
    const cause = salientFailure(stdout, stderr);
    super([
      `Command failed: ${command} (exit ${exitCode ?? 'unknown'})`,
      cause,
      logFile ? `Full output: ${logFile}` : '',
    ].filter(Boolean).join('\n'));
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
    this.logFile = logFile;
  }
}

export class CommandTimedOutError extends Error {
  override readonly name = 'CommandTimedOutError';
  readonly command: string;
  readonly timeoutMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly logFile: string;

  constructor(command: string, timeoutMs: number, stdout: string, stderr: string, logFile: string) {
    const cause = salientFailure(stdout, stderr);
    super([
      `Command timed out: ${command} after ${timeoutMs}ms`,
      cause,
      logFile ? `Full output: ${logFile}` : '',
    ].filter(Boolean).join('\n'));
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.stdout = stdout;
    this.stderr = stderr;
    this.logFile = logFile;
  }
}
