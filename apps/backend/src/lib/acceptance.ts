/**
 * The check that owns the whole deliverable, rather than any one piece of it.
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 * A five-leaf plan built an air-quality CLI. Every leaf succeeded, verified and merged. The
 * delivered program printed `AQI CLI` and exited: the entry point was a three-line stub from the
 * scaffolding leaf that nothing ever replaced, and the barrel that was written re-exported two of
 * the three modules and wired none of them together.
 *
 * Nothing was wrong with the leaf checks. Each verified what its leaf was for, and each passed
 * honestly. The gap is that no leaf's job was the WHOLE, so nothing ever ran the thing the user
 * actually asked for. The only reason it was caught is that a human cloned the repository and typed
 * the command — which is not a step a user should have to know to take.
 *
 * ── WHY A MODEL MAY WRITE THIS ONE ──
 * I argued against letting a planner author verify commands, because a predicate whose meaning the
 * planner controls can be made trivially true, turning a claim into a badge. That argument holds
 * for a per-leaf check that runs unseen. It does not hold here, and the difference is not honesty
 * but VISIBILITY: the acceptance command is declared while planning, shown in the conversation, and
 * read by whoever accepts the work. `echo ok` is not a check that slips through — it is a check
 * that is sitting in front of you before any work starts.
 *
 * The safeguard is not that the model would never cheat. It is that you saw the exam.
 */

const SENTINEL = 'KOALA_ACCEPT';

/**
 * Commands this will run.
 *
 * Deliberately permissive about CONTENT — an acceptance check is meant to look like the thing a
 * user would type, and constraining it to a grammar would rule out most real ones. Constrained
 * instead on shape: single line, bounded length, and nothing that chains into a second command,
 * because the value of showing it to a human before they accept depends on what they read being
 * all of what runs.
 */
export function usableAcceptance(command: unknown): string | undefined {
  if (typeof command !== 'string') return undefined;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 300) return undefined;
  if (/[\n\r]/.test(trimmed)) return undefined;
  // No command substitution or backgrounding. `&&` is allowed: "build then run" is a legitimate
  // acceptance check and reads as one thing.
  // `(?<!&)&(?!&)` is a LONE ampersand: in `&&` the first has one after it and the second has one
  // before, so the pair survives while backgrounding does not.
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
