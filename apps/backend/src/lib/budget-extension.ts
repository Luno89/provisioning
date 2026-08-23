/**
 * Giving a run more room, but only when it has earned it.
 *
 * ── THE PROBLEM WITH THE CEILING ──
 * A budget has to exist or a loop that never calls `finish` runs forever. But a fixed ceiling fires
 * at the same number whether the agent is one command from done or has written nothing at all, and
 * this codebase has the receipts on both sides of that:
 *
 *   · A leaf wrote 30 passing tests, committed them, pushed them, and hit the step ceiling before
 *     calling `finish`. The harness recorded a failure and never merged the branch, and the work
 *     sat on koala/7565dc49 for days. (sandbox-tools.ts)
 *   · A different leaf failed three times in a row having written nothing at all — forty turns each
 *     of `ls`, `cat`, `git log`, `git status`. It was not short of steps. It was never going to use
 *     them. (thrash.ts)
 *
 * Same ceiling, opposite right answers. So the question is not "how much budget" but "is this run
 * still producing", and the two cases above answer it cleanly.
 *
 * ── WHY THE VETOES MATTER MORE THAN THE SIGNALS ──
 * Raising a budget on a struggling run has been measured to make things WORSE, three separate
 * times: at 100 steps the agent simply searched for 100 steps instead of 40, and a later run at 100
 * died on context exhaustion instead. Extending a thrashing run is not a neutral mistake, it is a
 * regression of findings this repository already paid for. So a veto is absolute and is checked
 * before any evidence is weighed — and the loop already computes all three, which is the point:
 * they are the diagnoses it makes anyway.
 *
 * ── ANTI-GAMING ──
 * Every signal is read from the REPOSITORY or the DELIVERABLE, never from the agent's account of
 * itself. `decideStatus` exists because a claim and a result are different things; an agent that
 * could talk its way into more budget would make that worse, not better. The one signal that could
 * in principle be gamed by churning files (repository delta) is deliberately the weakest — see
 * `compareProgress`.
 */
import type { VerifyOutcome } from './leaf-verify.js';

/**
 * How many times a run may be extended.
 *
 * Two, each of the ORIGINAL budget rather than the current one, so the worst case is exactly twice
 * what the persona declared. A human can reason about "at most double"; they cannot reason about a
 * compounding series, and a runaway that compounds is the thing budgets exist to prevent.
 */
export const MAX_EXTENSIONS = 2;

/** Each extension is half the original budget again. */
export const EXTENSION_FRACTION = 0.5;

/**
 * What the repository and the deliverable looked like at one moment.
 *
 * Every field is optional because what is measurable depends on the leaf: a research leaf has no
 * commits, a coding leaf has no findings, and a leaf that declared no `expects` has no artifact
 * count. Absent means "not measurable here", never "zero".
 */
export interface ProgressSample {
  at: { step: number; tokens: number };
  /** What the verify command said, when one could be run. */
  verify?: VerifyOutcome | undefined;
  /** How many declared artifacts are still missing. Fewer is progress. */
  missingArtifacts?: number | undefined;
  /** Commits on this leaf's branch, against its base. */
  commits?: number | undefined;
  /** Lines changed against the base, excluding vendored paths. */
  changedLines?: number | undefined;
  /** Size of the deliverable file, for a persona that produces one. */
  findingsChars?: number | undefined;
  /** What `assessFindings` said about that deliverable. */
  findingsOutcome?: VerifyOutcome | undefined;
}

export interface ProgressEvidence {
  moved: boolean;
  /** Why, in words fit to show the agent and to log. Empty when nothing moved. */
  reasons: string[];
  /**
   * True when the ONLY evidence is repository churn.
   *
   * Separated because it is the one signal an agent could produce without doing the task — writing
   * and rewriting files is progress-shaped. Worth one extension, never two.
   */
  churnOnly: boolean;
}

/** Below this, a diff is noise: a reformat, a stray newline, a rewritten comment. */
const MEANINGFUL_LINES = 10;

/**
 * What moved between two samples, strongest evidence first.
 *
 * Ordered deliberately. A verification that went green is the strongest thing that can be said
 * about a run — it is the same signal `decideStatus` lets overrule the agent's own claim — and a
 * pile of changed lines is the weakest, because it is the only one that can be produced by
 * flailing.
 */
export function compareProgress(
  previous: ProgressSample | undefined,
  current: ProgressSample,
): ProgressEvidence {
  /**
   * No baseline, no claim. Progress means MOVEMENT, and movement cannot be observed from one
   * reading.
   *
   * Stated explicitly because the individual checks below read `previous?.x !== 'passed'`, which is
   * true when there is no previous at all — so a run whose tests already passed at its first
   * ceiling would have counted as having just made them pass. Callers take a baseline early (the
   * checkpoint driver does) precisely so that a ceiling has something to compare against.
   */
  if (!previous) return { moved: false, reasons: [], churnOnly: false };

  const reasons: string[] = [];
  let strong = false;

  // 1. Verification transitioned to passing. The strongest possible evidence, and the research
  //    literature's "tests went from failing to passing" in the form this harness already measures.
  if (current.verify === 'passed' && previous?.verify !== 'passed') {
    reasons.push('its tests now pass');
    strong = true;
  }

  // 2. Declared artifacts appearing. Cheap to check and impossible to fake — the file is committed
  //    and non-empty or it is not.
  const wasMissing = previous?.missingArtifacts;
  const nowMissing = current.missingArtifacts;
  if (typeof nowMissing === 'number' && typeof wasMissing === 'number' && nowMissing < wasMissing) {
    reasons.push(`${wasMissing - nowMissing} more of the files it promised now exist`);
    strong = true;
  }

  // 3. The deliverable got better, for a persona whose output is a document rather than a repo.
  if (current.findingsOutcome === 'passed' && previous?.findingsOutcome !== 'passed') {
    reasons.push('its answer now meets the bar');
    strong = true;
  } else if (
    typeof current.findingsChars === 'number'
    && typeof previous?.findingsChars === 'number'
    && current.findingsChars > previous.findingsChars * 1.2
  ) {
    reasons.push('its answer grew substantially');
    strong = true;
  }

  // 4. New commits. Real, but weaker: committing is not finishing.
  if (typeof current.commits === 'number' && current.commits > (previous?.commits ?? 0)) {
    reasons.push(`${current.commits - (previous?.commits ?? 0)} new commits`);
    strong = true;
  }

  // 5. Churn. Progress-shaped, and the only signal an agent could manufacture, so it counts on its
  //    own but is marked as such.
  let churnOnly = false;
  if (!reasons.length) {
    const lines = (current.changedLines ?? 0) - (previous?.changedLines ?? 0);
    if (lines >= MEANINGFUL_LINES) {
      reasons.push(`${lines} lines changed since the last check`);
      churnOnly = true;
    }
  }

  return { moved: reasons.length > 0, reasons, churnOnly: churnOnly && !strong };
}

export interface ExtensionState {
  /** Which ceiling was reached. Both are extendable; they just extend different numbers. */
  exhausted: 'steps' | 'tokens';
  extensionsUsed: number;
  evidence: ProgressEvidence;
  /** The loop's own diagnoses. Any one of these vetoes an extension outright. */
  thrashing: boolean;
  circling: boolean;
  silent: boolean;
  /** What the persona actually declared, so extensions never compound. */
  originalMaxSteps: number;
  originalMaxTokens: number;
  /**
   * Tokens the ROOT's budget still allows across the whole subtree, when one is set.
   *
   * Undefined means no budget is enforced, which is the current state of most installs — see
   * lib/budget-policy.ts. A leaf must not be able to extend past what its tree can afford.
   */
  headroomTokens?: number | undefined;
}

export interface Extension {
  steps?: number;
  tokens?: number;
  /** Said to the agent and written to the log. Names the evidence, not just the number. */
  reason: string;
}

/**
 * Whether to grant more room, and how much.
 *
 * Pure, and the rules live in one place, because these are exactly the rules that are cheap to get
 * subtly wrong and expensive to debug once real work runs through them — the same reason leaves.ts
 * is pure.
 */
/**
 * Why an extension was refused, in words, or undefined when it was granted.
 *
 * Exists because the first live run produced the log line "no extension (its answer now meets the
 * bar)" — which reports the EVIDENCE where a reader expects the CAUSE, and so reads as a
 * contradiction. A refusal has exactly one reason and the reader needs that one, not the argument
 * it overruled.
 *
 * Kept beside `decideExtension` and checked in the same order, so the two cannot disagree about why.
 */
export function refusalReason(state: ExtensionState): string | undefined {
  if (state.thrashing) return 'the run is thrashing — more room is the wrong answer';
  if (state.circling) return 'the run is repeating itself';
  if (state.silent) return 'the run stopped calling tools';
  if (state.extensionsUsed >= MAX_EXTENSIONS) return `already extended ${MAX_EXTENSIONS} times`;
  if (!state.evidence.moved) return 'nothing measurable moved';
  if (state.evidence.churnOnly && state.extensionsUsed >= 1) {
    return 'only file churn to show, and it has already been extended once';
  }
  if (state.exhausted === 'tokens') {
    const wanted = Math.ceil(state.originalMaxTokens * EXTENSION_FRACTION);
    const grant = typeof state.headroomTokens === 'number'
      ? Math.min(wanted, Math.max(0, state.headroomTokens))
      : wanted;
    if (grant < 2_000) return 'the request budget has nothing meaningful left to give';
  }
  return undefined;
}

export function decideExtension(state: ExtensionState): Extension | undefined {
  // ── The vetoes, first and absolutely ──────────────────────────────────────────────────────────
  // A loop that already knows it is stuck must not be handed more room to be stuck in. See the
  // header: this has been measured to make outcomes worse on three separate occasions.
  if (state.thrashing || state.circling || state.silent) return undefined;

  if (state.extensionsUsed >= MAX_EXTENSIONS) return undefined;
  if (!state.evidence.moved) return undefined;

  // Churn alone buys one extension, never two. It is the signal an agent could manufacture, so a
  // run that has nothing better to show after already being extended once is not progressing.
  if (state.evidence.churnOnly && state.extensionsUsed >= 1) return undefined;

  const reason = `granted because ${state.evidence.reasons.join(', and ')}`;

  if (state.exhausted === 'steps') {
    return { steps: Math.ceil(state.originalMaxSteps * EXTENSION_FRACTION), reason };
  }

  const wanted = Math.ceil(state.originalMaxTokens * EXTENSION_FRACTION);
  // Never past what the tree can afford. A subtree budget that a single leaf can overrun is not a
  // budget — and this is the only place a leaf learns about one.
  const grant = typeof state.headroomTokens === 'number'
    ? Math.min(wanted, Math.max(0, state.headroomTokens))
    : wanted;

  // A grant too small to produce anything is worse than none: it costs a probe and a notice, and
  // buys a turn that cannot finish. MIN is one meaningful turn's worth.
  if (grant < 2_000) return undefined;

  return { tokens: grant, reason };
}

/**
 * What the agent is told when it gets more room.
 *
 * Not optional, and not cosmetic. `buildAgentPrompt` bakes the step budget into the system prompt
 * ONCE, at the start of the run, so an extension that is not announced leaves the agent working to
 * a number that is no longer true — and sandbox-tools.ts documents exactly this class of bug ("it
 * typechecks, it runs, and the two quietly disagree"), with step-budget.test.ts guarding it.
 *
 * The evidence is included because it is also an instruction: it tells the agent which thread was
 * the productive one.
 */
export function extensionNotice(extension: Extension, newCeiling: number, unit: 'steps' | 'tokens'): string {
  return [
    `Your budget has been extended to ${newCeiling.toLocaleString()} ${unit} — ${extension.reason}.`,
    '',
    'Ignore any earlier statement of your budget; this is the number that applies now. Carry on with',
    'what was working. Do not start over, and do not spend the extra room re-checking what you have',
    'already done.',
  ].join('\n');
}
