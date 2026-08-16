/**
 * What happened to a run, as distinct from whether it scored.
 *
 * ── THE FAILURE THIS EXISTS FOR ──
 * Measured in one afternoon: a model server was OOMKilled mid-suite and thirteen runs came back
 * with `verified: false`. Read as a score that is "2/15" — a dramatic-looking result, and a
 * completely false one, since thirteen of those runs never executed a single step. Separately, an
 * arm verified 4/4 while claiming 0/4, because it produced correct work every time and hit its
 * step cap before calling finish; scored as a boolean that reads as a failing arm.
 *
 * Neither was visible in the number. Both were obvious in the record, which already held every
 * field needed to tell them apart — nothing was reading it.
 *
 * ── STRUCTURAL SIGNALS, NOT PROSE ──
 * Step exhaustion is detected from `request.loop.maxSteps`, which is recorded per run, rather than
 * by matching the summary string. The string is written in one place and read in none, so matching
 * it would make a reworded message silently reclassify every run that hit a cap.
 */
import type { RunOutcome, OutcomeCounts, VariantResult } from '@koala/harness-types';

export type { RunOutcome, OutcomeCounts };

/**
 * A run that produced nothing at all.
 *
 * Zero steps AND zero tokens means no turn ever completed — the model was unreachable, the sandbox
 * never came up, or the process was killed. A genuine attempt that failed instantly still spends a
 * turn, so this cannot be confused with a fast wrong answer.
 */
function neverRan(result: VariantResult): boolean {
  return result.steps === 0 && result.tokensUsed === 0;
}

/**
 * Whether the loop stopped because it ran out of budget rather than because it was done.
 *
 * `outOfBudget` is set by the loop itself and is the authoritative answer — steps stopped being the
 * binding limit once tokens became the real budget, so comparing a step count to a cap now misses
 * every run that stopped on spend. The step comparison is kept as a fallback for records written
 * before the flag existed.
 */
function exhausted(result: VariantResult): boolean {
  if ((result as { outOfBudget?: boolean }).outOfBudget) return !result.succeeded;
  const cap = result.request?.loop?.maxSteps;
  // Only when the cap is known: inferring exhaustion from a step count with nothing to compare it
  // against would classify every long run as incomplete.
  return cap !== undefined && result.steps >= cap && !result.succeeded;
}

export function classifyOutcome(result: VariantResult): RunOutcome {
  // Checked first and unconditionally: an infrastructure failure that also happens to have failed
  // verification is still an infrastructure failure, and counting it as `wrong` is what puts a
  // harness outage into a variant's score.
  if (result.error || neverRan(result)) return 'broken';
  if (result.verified) return 'verified';
  if (exhausted(result)) return 'incomplete';
  return 'wrong';
}

export function countOutcomes(results: VariantResult[]): OutcomeCounts {
  const counts: OutcomeCounts = { verified: 0, wrong: 0, incomplete: 0, broken: 0 };
  for (const r of results) counts[classifyOutcome(r)] += 1;
  return counts;
}

/**
 * Runs that got a fair attempt — the denominator a score should use.
 *
 * `broken` runs leave it entirely rather than counting against the arm. A variant that ran twice
 * and passed twice is 2/2 with thirteen not run; calling that 2/15 is not a cautious reading, it
 * is a wrong one, and it is the reading that nearly stood.
 */
export function attempted(results: VariantResult[]): VariantResult[] {
  return results.filter((r) => classifyOutcome(r) !== 'broken');
}

/**
 * Runs where the agent's self-report disagreed with verification, in whichever direction.
 *
 * Both directions matter and only one was being reported. Overclaiming is the famous one — a run
 * that says it succeeded and did not. Underclaiming is the arm that verified 4/4 while claiming
 * 0/4: its work was right and it could not tell, which is a harness problem (a step budget, a
 * missing finish instruction) wearing the costume of a capability problem.
 */
export function claimGap(results: VariantResult[]): { overclaimed: VariantResult[]; underclaimed: VariantResult[] } {
  const fair = attempted(results);
  return {
    overclaimed: fair.filter((r) => r.succeeded && !r.verified),
    underclaimed: fair.filter((r) => !r.succeeded && r.verified),
  };
}

/**
 * Knobs that were asked for but did not reach the request.
 *
 * The Lab's whole claim is that a run records what it actually ran under, and twice now a variant
 * has been named after a configuration it was not running: a `temperature` axis that was never
 * sent, and a "DRY-boosted" arm whose values were identical to the built-in defaults. Both were
 * found by reading `request.parameters` by hand. This is that comparison, done automatically.
 *
 * `unsupported` keys are excluded — a knob dropped because it is gated to another engine was
 * dropped deliberately, and the request already says so.
 */
export function droppedOverrides(result: VariantResult): string[] {
  const asked = result.request?.overrides;
  if (!asked) return [];
  const sent = result.request?.parameters ?? {};
  const loop = result.request?.loop ?? {};
  const unsupported = new Set(result.request?.unsupported ?? []);

  const prompt = result.request?.systemPrompt ?? '';

  return Object.keys(asked)
    .filter((key) => !unsupported.has(key))
    .filter((key) => {
      // A knob counts as delivered if it reached the wire, the loop, or the prompt — the three
      // places a tunable can legitimately land.
      if (key in sent) return false;
      if (key in loop) return false;
      /**
       * Prompt-placement knobs land as TEXT, so delivery is checked by looking for the text.
       *
       * Not a list of key names: the first version special-cased `systemPrompt` and duly reported
       * that `extraInstructions` had never reached the model on all four arms of a 40-run suite.
       * It had — appended to the prompt, which the record showed ending with it verbatim. A check
       * that invents failures is worse than no check, because this one exists to be believed.
       */
      const value = (asked as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim() && prompt.includes(value.trim())) return false;
      // Renamed on the wire: `think` travels as `enable_thinking` under template_vars.
      const vars = (sent as Record<string, unknown>).template_vars;
      if (vars && typeof vars === 'object' && Object.keys(vars).length) {
        if (key === 'think' && 'enable_thinking' in (vars as Record<string, unknown>)) return false;
      }
      return true;
    })
    .sort();
}
