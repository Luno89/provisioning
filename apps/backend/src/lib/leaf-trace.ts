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
  createdAt: string;
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
