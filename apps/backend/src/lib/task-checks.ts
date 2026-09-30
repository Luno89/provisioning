import type { TaskChecks } from '../engine-host/tools/tasks.js';

/**
 * The checks a task carries, run where the claim says the work is.
 *
 * A check is code: a file that must exist, a pattern that must match, a command that must exit clean
 * and say certain things, an endpoint that must answer. None of it is a matter of opinion, so none of
 * it is put to the model — a claim whose checks fail is settled against, and the leaf goes back to be
 * replanned with the failure in hand. The judge weighs the prose; this weighs the rest.
 */

/** The slice of a sandbox the checks need, so they can be tested against a fake. */
export interface CheckEnvironment {
  exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string | undefined>;
}

export interface CheckOutcome {
  /** what was checked, in words a replan can act on */
  check: string;
  passed: boolean;
  says: string;
}

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

async function fileExists(environment: CheckEnvironment, path: string): Promise<CheckOutcome> {
  const outcome = await environment.exec(`test -s ${quote(path)}`);
  return {
    check: `${path} exists and is not empty`,
    passed: outcome.exitCode === 0,
    says: outcome.exitCode === 0 ? 'it is there' : 'it is missing or empty',
  };
}

async function contentMatches(environment: CheckEnvironment, path: string, pattern: string): Promise<CheckOutcome> {
  const check = `${path} matches ${pattern}`;
  let content: string | undefined;
  try {
    content = await environment.readFile(path);
  } catch {
    content = undefined;
  }
  if (content === undefined) return { check, passed: false, says: 'the file could not be read' };

  let matches: boolean;
  try {
    matches = new RegExp(pattern, 'm').test(content);
  } catch (err) {
    // A pattern that is not a regular expression is a plan's mistake, and it is not the work's fault —
    // but it cannot pass either, so it fails saying what is wrong with the pattern.
    return { check, passed: false, says: `the pattern is not a regular expression: ${(err as Error).message}` };
  }

  return { check, passed: matches, says: matches ? 'the pattern is in it' : 'the pattern is not in it' };
}

async function runCommand(environment: CheckEnvironment, command: string, expects: readonly string[]): Promise<CheckOutcome> {
  const check = `${command}${expects.length > 0 ? ` says ${expects.map((entry) => `"${entry}"`).join(', ')}` : ' exits clean'}`;
  const outcome = await environment.exec(command);
  if (outcome.exitCode !== 0) {
    return { check, passed: false, says: `it exited ${outcome.exitCode}: ${(outcome.stderr || outcome.stdout).trim().slice(0, 400) || 'no output'}` };
  }

  const said = `${outcome.stdout}\n${outcome.stderr}`;
  const missing = expects.filter((entry) => !said.includes(entry));
  return missing.length > 0
    ? { check, passed: false, says: `its output did not contain ${missing.map((entry) => `"${entry}"`).join(', ')}` }
    : { check, passed: true, says: 'it exited clean and said what was expected' };
}

async function httpProbe(environment: CheckEnvironment, url: string, status: number): Promise<CheckOutcome> {
  const check = `${url} answers ${status}`;
  // Probed from inside the sandbox, because that is the network the work lives on.
  const outcome = await environment.exec(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 20 ${quote(url)}`,
  );

  if (outcome.exitCode === 127) return { check, passed: false, says: 'curl is not installed in the workspace, so the endpoint could not be probed' };
  const answered = (outcome.stdout || '').trim();
  return {
    check,
    passed: outcome.exitCode === 0 && answered === String(status),
    says: outcome.exitCode === 0 ? `it answered ${answered || 'nothing'}` : `the probe failed: ${(outcome.stderr || outcome.stdout).trim().slice(0, 200) || 'no output'}`,
  };
}

/** Every check a task carries, in the order a person would read them. */
export async function runTaskChecks(environment: CheckEnvironment, checks: TaskChecks | undefined): Promise<CheckOutcome[]> {
  if (!checks) return [];

  const outcomes: CheckOutcome[] = [];
  if (checks.fileExists) outcomes.push(await fileExists(environment, checks.fileExists));
  if (checks.contentPath && checks.contentPattern) outcomes.push(await contentMatches(environment, checks.contentPath, checks.contentPattern));
  if (checks.command) outcomes.push(await runCommand(environment, checks.command, checks.expects ?? []));
  if (checks.httpUrl) outcomes.push(await httpProbe(environment, checks.httpUrl, checks.httpStatus ?? 200));

  return outcomes;
}

export const checksFailed = (outcomes: readonly CheckOutcome[]): boolean => outcomes.some((outcome) => !outcome.passed);

/** What a claim settled against by its checks carries, so the replan can see which one and why. */
export function checkReport(outcomes: readonly CheckOutcome[]): string {
  return outcomes
    .map((outcome) => `${outcome.passed ? 'passed' : 'FAILED'} — ${outcome.check}: ${outcome.says}`)
    .join('\n');
}
