/**
 * A subprocess failure that survives the trip into Temporal history.
 *
 * ── WHY THIS EXISTS ──
 * `InfrastructureService.runCommand` used to reject with an object LITERAL:
 *
 *   reject({ message: `Command failed: ${cmd}`, stdout, stderr, logFile })
 *
 * A plain object is not an Error. Temporal serialises it as
 * `applicationFailureInfo.type: "Object"` with `stackTrace: "undefined"`, and keeps only the
 * `message` — so `stdout` and `stderr` are dropped on the floor. Measured: an app deploy failed
 * because an admission webhook was rejecting every Ingress, and the entire recorded cause was
 * the four words `Command failed: npx`. The real error existed only in a log file on disk, and
 * finding it took three runs and a trace.
 *
 * So the failure carries its own evidence: a real Error (type and stack), the salient line from
 * the output IN THE MESSAGE where workflow history will keep it, and the log path for the rest.
 *
 * Pure and dependency-free, so it can be unit-tested against real captured output and imported by
 * both services and activities without breaking the one-way arrow.
 */

/** Control characters are stripped before matching: a colourised line matches nothing otherwise. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Lines worth putting in front of a person.
 *
 * Ordered by how specific they are. Terraform and CDKTF write the actual cause to STDOUT inside a
 * box-drawn block, so "read stderr" is not enough — the webhook rejection that started all this
 * was on stdout while stderr was empty.
 */
const ERROR_PATTERNS = [
  /\bError:/,
  /\bfailed calling webhook\b/i,
  /\bx509:/,
  /\bENOENT\b|\bEACCES\b|\bECONNREFUSED\b/,
  /\berror\b.*\bexit code\b/i,
  /\bfailed\b/i,
];

/** How much of the output to quote. Enough to name a cause, short enough to read in a UI. */
const MAX_SUMMARY = 600;
/** How many trailing lines to fall back to when nothing looks like an error. */
const TAIL_LINES = 3;

/**
 * The most likely cause, drawn from whichever stream carries it.
 *
 * Returns '' rather than a guess when there is no output — a command that printed nothing has no
 * cause to report, and inventing one would put a confident sentence on an empty box.
 */
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

/** A timeout is a different fact from a non-zero exit, and says so. */
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
