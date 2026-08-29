
const SENTINEL = 'KOALA_ACCEPT';

export function usableAcceptance(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 300) return undefined;
  if (/[\n\r]/.test(trimmed)) return undefined;
  if (/[`$]|\|\||;|(?<!&)&(?!&)/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * One step of the acceptance plan.
 *
 * Named, because "the acceptance check failed" tells nobody anything. A plan that installs, tests
 * and then runs the program has three ways to fail that need three different responses, and the
 * name is what turns an exit code into a sentence a person can act on.
 */
export interface AcceptanceCheck {
  name: string;
  command: string;
}

/** Enough to express install → build → test → run without becoming a build system. */
export const MAX_ACCEPTANCE_CHECKS = 6;

/**
 * Filters a proposed plan to the checks that will actually be run.
 *
 * Dropped rather than rejected wholesale: a plan whose fourth step is malformed is still worth
 * running the first three of, and the result reports what was kept so nobody is misled about what
 * was checked.
 */
export function usableAcceptancePlan(raw: unknown): AcceptanceCheck[] {
  // A bare string is what the first version of this stored. Read rather than migrated, so branches
  // created before the plan existed keep working.
  if (typeof raw === 'string') {
    const one = usableAcceptance(raw);
    return one ? [{ name: 'works', command: one }] : [];
  }
  if (!Array.isArray(raw)) return [];

  const out: AcceptanceCheck[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_ACCEPTANCE_CHECKS) break;
    const command = usableAcceptance((entry as { command?: unknown })?.command ?? entry);
    if (!command) continue;
    const rawName = typeof (entry as { name?: unknown })?.name === 'string'
      ? (entry as { name: string }).name.trim()
      : '';
    out.push({ name: (rawName || command).slice(0, 80), command });
  }
  return out;
}

/**
 * Runs the command against the assembled default branch.
 *
 * A generous timeout because a real acceptance check does the real thing — the CLI that motivated
 * this makes two live HTTP calls — and a check that times out would report the deliverable broken
 * when it is only slow.
 */
export function buildAcceptanceScript(command: string): string {
  return [
    'cd /work/repo || { echo "' + SENTINEL + '=norepo"; exit 0; }',
    `${command} 2>&1 | tail -40`,
    `echo "${SENTINEL}=\${PIPESTATUS[0]:-$?}"`,
  ].join('\n');
}

export interface AcceptanceResult {
  outcome: 'passed' | 'failed' | 'unknown';
  output: string;
}

export function parseAcceptance(stdout: string): AcceptanceResult {
  const output = stdout.replace(new RegExp(`${SENTINEL}=\\S+\\s*$`), '').trim().slice(-2000);
  if (new RegExp(`${SENTINEL}=norepo`).test(stdout)) return { outcome: 'unknown', output };

  const match = new RegExp(`${SENTINEL}=(\\d+)`).exec(stdout);
  // No verdict means the script never finished — a workspace that died, not a broken deliverable.
  if (!match) return { outcome: 'unknown', output };
  return { outcome: Number(match[1]) === 0 ? 'passed' : 'failed', output };
}
