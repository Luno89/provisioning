/**
 * Noticing that an agent has stopped producing anything, without waiting for its step budget.
 *
 * ── WHY THE STEP CAP IS THE WRONG INSTRUMENT ──
 * `MAX_AGENT_STEPS` is a termination guarantee, and it has to exist: an agent that never calls
 * `finish` would otherwise run forever. But it is a bad DETECTOR. It fires at the same number
 * whether the agent is one command from done or has written nothing at all, and raising it does not
 * help — measured twice and recorded in sandbox-tools.ts: at 100 steps the agent simply searched for
 * 100 steps instead of 40, and a later run at 100 died on context exhaustion instead.
 *
 * ── WHAT SEPARATES THE TWO CASES ──
 * Every successful run measured here began producing early: a LICENSE leaf wrote at turn 3, a client
 * module at 6, another at 9. The leaf that failed three times in a row never wrote anything at all —
 * forty turns each of `ls`, `cat`, `git log`, `git status`, `node --version`, `npm ls`, `find`. It
 * was not short of steps. It was never going to use them.
 *
 * So the signal is not how many turns have passed, it is how many have passed WITHOUT PRODUCING
 * ANYTHING. That separates the observed successes from the observed failure with room to spare, and
 * it fires around turn eight rather than turn forty — before three attempts have burned 62,947
 * tokens rediscovering the same repository.
 *
 * The cap stays. It is the backstop; this is meant to be what actually fires.
 */

/**
 * Turns of pure inspection before the agent is told, in as many words, to start.
 *
 * Above the slowest successful start measured (9) with margin, so a run that is merely thorough is
 * not interrupted for it.
 */
export const NUDGE_AFTER = 12;

/**
 * Turns of pure inspection before the run is abandoned.
 *
 * An agent that has been told to write something and has spent another eight turns looking at the
 * repository instead is not going to. Stopping here leaves the remaining budget unspent rather than
 * spending it on more of the same.
 */
export const STOP_AFTER = 20;

/**
 * Commands that change something.
 *
 * Deliberately a list of MUTATIONS rather than "not a read": an unknown command should count as
 * unproductive, because the failure being caught is an agent inventing new ways to look around. A
 * false "productive" silences the detector; a false "unproductive" only costs a nudge.
 */
const MUTATING = [
  />{1,2}\s*(?!\/dev\/null)/,        // redirection into a real file
  /\btee\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\bcp\b|\bmv\b|\brm\b/,
  /\bsed\s+-i\b/,
  /\bgit\s+(commit|apply|cherry-pick|revert|merge|push)\b/,
  /\bpatch\b/,
  /\bnpm\s+init\b/,
];

/**
 * NOT in that list, deliberately: `npm install`, `pip install`, `go mod download`.
 *
 * They look like production and cannot be, here. The sandbox has no route to a package registry —
 * `registry.npmjs.org` answers "connection refused" — so an install changes nothing at all. Counting
 * it as productive was measured against a real trace and defeated the detector on exactly the run it
 * exists for: the agent ran `npm init -y` then `npm install --save-dev jest`, which reset the
 * counter twice while it produced nothing, and it went on to fail without writing a line.
 */

/**
 * Whether a turn produced anything, as opposed to looking at something.
 *
 * `write_file` always counts. `run_command` counts only when the command mutates — running the test
 * suite is valuable and is not production, and a run whose every turn is `node --test` against a
 * file that does not exist is exactly the loop this is for.
 */
export function isProductive(calls: { name: string; arguments: string }[]): boolean {
  for (const call of calls) {
    if (call.name === 'write_file') return true;
    if (call.name !== 'run_command') continue;
    let command = call.arguments;
    try {
      command = String(JSON.parse(call.arguments)?.command ?? call.arguments);
    } catch {
      // A truncated argument is normal on a long call; the raw text still contains the command.
    }
    if (MUTATING.some((pattern) => pattern.test(command))) return true;
  }
  return false;
}

export type ThrashAction = 'continue' | 'nudge' | 'stop';

export function thrashAction(unproductiveTurns: number): ThrashAction {
  if (unproductiveTurns >= STOP_AFTER) return 'stop';
  if (unproductiveTurns === NUDGE_AFTER) return 'nudge';
  return 'continue';
}

/**
 * What the agent is told when it has been looking around for too long.
 *
 * Names the count and the commands, because a vague "get on with it" is what the pacing notes
 * already say and it did not work. Being told "you have run twelve commands and written nothing" is
 * a fact it can check against its own transcript.
 */
export function nudgeMessage(unproductiveTurns: number, recentCommands: string[]): string {
  const recent = recentCommands.slice(-3).map((c) => `\`${c.slice(0, 80)}\``).join(', ');
  return [
    `You have taken ${unproductiveTurns} turns without creating or changing a single file.`,
    recent ? `The last things you ran were ${recent} — all of them inspect, none of them produce.` : '',
    'Stop looking. Write the file you were asked for now, with write_file, even if it is imperfect;',
    'you can correct it afterwards. If you genuinely cannot, call finish and say what is blocking you.',
  ].filter(Boolean).join(' ');
}

/** How the run is reported when it is abandoned for this. Distinct from running out of steps. */
export function thrashSummary(unproductiveTurns: number, recentCommands: string[]): string {
  return `Stopped after ${unproductiveTurns} turns that produced nothing — the agent inspected the `
    + `workspace repeatedly and never created or changed a file. This is not a budget problem: the `
    + `remaining steps were left unspent because more of the same would not have helped. `
    + `Last commands: ${recentCommands.slice(-3).join(' | ') || 'none'}`;
}
