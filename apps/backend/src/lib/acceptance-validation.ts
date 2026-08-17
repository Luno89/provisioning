import type { AcceptanceCheck } from './acceptance.js';

/**
 * Refusing an acceptance check that cannot fail.
 *
 * ── THE CHECK THAT PASSED THE GATE ──
 * Blocking acceptance on "is there a plan?" bought exactly one turn of honesty. The very next
 * planning turn called `set_acceptance` — the new rule worked — with this:
 *
 *     "command": "echo 'Verification done via MCP tool calls in leaf'"
 *
 * `echo` exits 0 always. It satisfies the gate, runs at the end of the request, reports `passed`,
 * and proves nothing whatsoever. That is the same hollow green this whole session has been digging
 * out, one level up: a check whose result does not depend on the work.
 *
 * `set_acceptance`'s own description already said "Each check must exit non-zero when that aspect
 * is broken, or it proves nothing" — a sentence the model had read and agreed with, in the same
 * turn it wrote an echo. Description is not enforcement.
 *
 * ── TWO LAYERS, AND WHY THE CHEAP ONE IS NOT REDUNDANT ──
 * `AuthoringService.validateOnEmptyWorkspace` is the authoritative test: run the command with
 * nothing present and require it to FAIL. It is also a pod, thirty seconds, and a cluster that has
 * to be up.
 *
 * This module is the part that needs none of those. It rejects commands that provably cannot fail
 * on inspection alone, which is the whole observed population so far, and it answers instantly —
 * inside the same tool call, so the model can fix it in the turn where it still has the context to.
 * It never has an opinion on whether a check is GOOD, only on whether it can distinguish anything
 * at all.
 */

/**
 * Commands whose exit status is a constant zero, whatever the state of the world.
 *
 * Deliberately a small, closed list of things with no observable input. Anything that reads a file,
 * runs a binary, or calls a service can fail, and is left alone — a check that fires on merely
 * unusual commands gets the gate turned off, and then nothing is checked at all.
 */
const ALWAYS_TRUE = /^(echo\b|printf\b|true$|:$|exit\s+0$|cd\s+\S+$|ls$|pwd$|sleep\s+\d+$)/;

/** Why this command cannot serve as a check, or undefined when it might. */
export function cannotFail(command: string): string | undefined {
  const trimmed = String(command ?? '').trim();
  if (!trimmed) return 'is empty';

  /**
   * Judged on the LAST link of an `&&` chain, because that is what decides the exit status.
   *
   * `npm test && echo ok` exits 0 even when the suite fails — the chain's earlier failure is
   * swallowed by the echo that follows it. This is the shape a model reaches for when asked to
   * make a check "report" something, and it is strictly worse than the bare echo because it looks
   * like it runs the tests.
   */
  const links = trimmed.split('&&').map((s) => s.trim()).filter(Boolean);
  const last = links[links.length - 1] ?? trimmed;

  if (ALWAYS_TRUE.test(last)) {
    return links.length > 1
      ? `ends in \`${last}\`, so it exits 0 even when the earlier commands fail`
      : `is \`${last}\`, which always exits 0`;
  }
  // `|| true` and `; true` discard the failure they were supposed to report.
  if (/\|\|\s*(true|:)\s*$/.test(trimmed)) return 'ends in `|| true`, which discards any failure';
  return undefined;
}

export interface CheckVerdict {
  name: string;
  command: string;
  reason: string;
}

/** Every check in the plan that cannot fail. Empty means nothing was provably hollow. */
export function hollowChecks(plan: readonly AcceptanceCheck[]): CheckVerdict[] {
  const out: CheckVerdict[] = [];
  for (const check of plan) {
    const reason = cannotFail(check.command);
    if (reason) out.push({ name: check.name, command: check.command, reason });
  }
  return out;
}

/**
 * What the model is told when its plan is refused.
 *
 * Says what a real check looks like, because "this is wrong" without "here is the shape" gets the
 * same command back with different wording — measured on the failure modes of every other refusal
 * in this file's neighbourhood.
 */
export function explainHollow(verdicts: readonly CheckVerdict[]): string {
  const lines = verdicts.map((v) => `  · "${v.name}": \`${v.command}\` ${v.reason}`);
  return (
    `${verdicts.length === 1 ? 'This check cannot fail' : 'These checks cannot fail'}, so running `
    + `${verdicts.length === 1 ? 'it' : 'them'} proves nothing:\n${lines.join('\n')}\n`
    + 'A check must exit non-zero when the thing is broken. Run the code and let its own exit '
    + 'status decide — call the service and check the response, run the test suite, execute the '
    + 'entry point with real arguments. Do not append `echo`, and do not end with `|| true`.'
  );
}
