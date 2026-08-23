/**
 * What a leaf actually did, turn by turn, kept so a run can be replayed after it ends.
 *
 * ── WHY THIS WAS MISSING ──
 * The agent loop has produced this all along — `captureTrace` — and only the Lab ever asked for it.
 * A leaf kept a one-line `summary`, so the moment a run finished, "why did it do that" was
 * unanswerable. Every diagnosis of a failing leaf in this codebase so far has been done by
 * re-running it by hand with a probe script, which only works while the cause is still reproducible.
 *
 * ── WHY IT IS NOT ON THE LEAF ──
 * `getLeaves()` returns every leaf the owner has, and it is what the board, the chat route and the
 * reconcile loop all call. A trace is the largest thing a leaf produces — up to MAX_AGENT_STEPS
 * turns of reasoning, arguments and results — so storing it on the leaf would put megabytes into
 * every list query to serve a panel that is only opened deliberately.
 *
 * Its own collection, fetched by id on drill-in. That also makes the retention this still owes
 * (see ~/.claude/plans/agent-harness.md) a delete against one collection rather than a rewrite of
 * every leaf.
 */
import type { AgentStep } from '@koala/harness-types';

export interface LeafTrace {
  /** The leaf id. One trace per leaf; a retry REPLACES it, because it describes the run that stands. */
  id: string;
  ownerId: string;
  branchId: string;
  steps: AgentStep[];
  /** Set when steps were dropped to fit, so the UI can say so rather than implying a short run. */
  trimmed?: boolean;
  /** Total turns before trimming — what the run actually took. */
  totalSteps: number;
  tokensUsed: number;
  /**
   * Save points written during the run.
   *
   * Small, so it belongs here rather than in its own collection — and it has to be somewhere,
   * because `steps` is only the window SINCE THE LAST RESET. Without this, a checkpointed run's
   * trace silently describes the last third of itself and nothing says so.
   */
  checkpoints?: { step: number; tokensUsed: number; sha?: string; branch?: string }[];
  /**
   * The artifacts a run left behind, captured before the sandbox was destroyed.
   *
   * ── WHY THIS EXISTS EVEN IF NOTHING READS IT YET ──
   * `failure-review.ts` diagnoses a failed leaf and has never been given a DIFF — it sees the
   * summary and the error and nothing the run actually wrote. "Did the tests exercise the new code"
   * has been unanswerable for every leaf in this codebase's history.
   *
   * It also happens to be the only honest input for a judge. The abandoned harness-v2 branch scored
   * work against a hardcoded `gitDiff: '+export const feature = true;'`, which is the failure mode
   * this field exists to make impossible: a judge is exactly as good as the artifacts it reads.
   *
   * Lives on the TRACE, not the leaf — `getLeaves()` is called by the board, the chat route and the
   * reconcile loop, and a diff on the leaf would land in every list query to serve a panel opened
   * deliberately. See this file's header.
   */
  evidence?: LeafEvidence;
  createdAt: string;
}

/** What a finished run left behind, in the form someone (or something) could check it. */
export interface LeafEvidence {
  /** `git diff --stat` against the base, then per-file patches until the budget runs out. */
  diff?: string;
  /** True when the diff was cut short, so a reader never mistakes a partial for the whole. */
  diffTruncated?: boolean;
  /** What the verify command printed. Already capped at 2,000 chars by parseVerifyResult. */
  verifyOutput?: string;
  /** The declared artifacts, as they actually ended up. */
  expects?: { path: string; content: string; truncated?: boolean }[];
  /** The deliverable, for a persona that produces a document rather than a repository. */
  findings?: string;
  capturedAt: string;
}

/**
 * Everything the deterministic layers concluded, small enough to live on the leaf itself.
 *
 * Anticipated by a comment in ExecuteLeafActivity — "every outcome is recorded on the leaf so it
 * can be answered with numbers later rather than by picking now" — and never actually written. The
 * board renders one word; this is the rest of the sentence.
 */
export interface LeafChecks {
  verify: { command?: string; outcome: string };
  artifacts: { outcome: string; missing?: string[] };
  docker?: { problems: boolean };
  findings?: { outcome: string };
  /** `combineVerification` of the above — what actually decided the status. */
  combined: string;
  /** The status that was written, after the docker gate and the agent's claim were folded in. */
  settled: string;
}

/**
 * Total characters a stored trace may occupy.
 *
 * The loop already caps each FIELD of each step; nothing caps the whole. Forty steps at their
 * per-field ceilings is roughly 440 KB, which one Mongo document tolerates and a thousand leaves do
 * not. This is the bound that makes the growth linear in leaves rather than in leaves × steps.
 */
export const MAX_TRACE_CHARS = 120_000;

/** Opening turns always kept — they are the approach, and dropping them loses WHY. */
export const KEEP_OPENING = 3;

/**
 * Fits a trace inside the budget, keeping both ends.
 *
 * Not oldest-first like `trimTranscript`, which is right for a conversation being CONTINUED — there,
 * only recent context still matters. A trace is read afterwards by someone asking one of two
 * questions: what was it trying to do (the opening) and what went wrong (the end). Dropping either
 * end answers only half.
 *
 * So the opening turns are kept, the most recent turns fill the rest, and the gap is explicit.
 */
export function trimTrace(steps: AgentStep[], budget = MAX_TRACE_CHARS): { steps: AgentStep[]; trimmed: boolean } {
  const size = (s: AgentStep) => JSON.stringify(s).length;
  const total = steps.reduce((n, s) => n + size(s), 0);
  if (total <= budget) return { steps, trimmed: false };

  const opening = steps.slice(0, KEEP_OPENING);
  let used = opening.reduce((n, s) => n + size(s), 0);

  // Backwards from the end, taking whatever still fits.
  const tail: AgentStep[] = [];
  for (let i = steps.length - 1; i >= opening.length; i--) {
    const s = steps[i]!;
    const cost = size(s);
    if (used + cost > budget) break;
    used += cost;
    tail.unshift(s);
  }

  return { steps: [...opening, ...tail], trimmed: true };
}

/** How many turns are missing from a trimmed trace, for the UI to say so. */
export function droppedCount(trace: Pick<LeafTrace, 'steps' | 'totalSteps'>): number {
  return Math.max(0, trace.totalSteps - trace.steps.length);
}
