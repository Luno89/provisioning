/**
 * Asking the orchestrator why a leaf failed, and putting the answer where it can be argued with.
 *
 * ── WHY THIS IS NOT A RETRY ──
 * Retrying is cheap and often right: the loop already feeds the previous failure back, so attempt
 * two is not attempt one. But a leaf that has failed three times is not unlucky, it is blocked on
 * something the agent cannot see — and every such case in this codebase so far has been exactly
 * that. The token ceiling that truncated `write_file` looked like a model giving up. The egress
 * rule rendered as "these hosts: ." made it run `npm install` against a registry it could not
 * reach. Neither was fixable by trying again; both were obvious from the trace once someone read it.
 *
 * So the action is a READING, not a rerun.
 *
 * ── AND WHY THE ANSWER GOES INTO THE CONVERSATION ──
 * An analysis rendered in a panel is a dead end — you read it and then have nowhere to reply. The
 * branch transcript is already the place where things get discussed, and anything written there is
 * context for the next turn by construction. So the review is posted as a message: the user can
 * argue with it, ask for detail, or tell the planner to change the plan, using the chat that
 * already exists. No new plumbing, and the disagreement is recorded next to the work.
 */
import type { Leaf, LeafAttempt } from './leaves.js';
import type { LeafTrace } from './leaf-trace.js';

/** How much of the trace goes into the prompt. The whole thing is far larger than one turn wants. */
export const REVIEW_TRACE_STEPS = 14;
export const REVIEW_STEP_CHARS = 600;

/**
 * The one instruction that matters.
 *
 * Written against how these failures have actually read: the model's own last words are usually
 * confident and wrong ("Let me create both files now"), and the informative part is the SHAPE — a
 * command that returned nothing, a call that never appeared, the same step repeated. A reviewer
 * that summarises the agent's narration reproduces the mistake rather than diagnosing it.
 */
export const REVIEW_PROMPT = [
  'A piece of work failed. Read the record and say why.',
  '',
  'What is wanted is a diagnosis, not a summary. The agent\'s own account of what it was doing is',
  'the least reliable thing here — it is usually confident and usually wrong about the cause. Look',
  'instead at what actually happened: a command that produced no output, a tool call that was',
  'announced and never arrived, the same step repeated, an error that was reported and then ignored.',
  '',
  'Answer three things, briefly:',
  '1. What went wrong — the mechanism, not the symptom.',
  '2. Whether retrying would help. Say plainly if it would not, and why.',
  '3. What would actually fix it — a change to the task, the environment, or the platform itself.',
  '',
  'If the evidence does not support a conclusion, say that instead of inventing one. "The trace',
  'stops without explanation" is a useful answer; a confident guess is not.',
].join('\n');

function describeAttempts(attempts: LeafAttempt[]): string {
  if (!attempts.length) return 'No previous attempts were recorded.';
  return attempts
    .map((a, i) => `Attempt ${i + 1}: ${String((a as { error?: string }).error ?? (a as { summary?: string }).summary ?? 'no reason recorded').slice(0, 700)}`)
    .join('\n');
}

/**
 * The turns, most recent last, clipped.
 *
 * The END of a trace is where a failure lives, so when there are more turns than fit, the ones
 * kept are the last ones — the opposite of what `trimTrace` does for STORAGE, where the opening
 * matters because someone may be reading to understand the approach. Here the reader has already
 * decided something is wrong.
 */
function describeTrace(trace: LeafTrace | null): string {
  if (!trace || !trace.steps.length) {
    return 'No turn-by-turn record was kept for this run, so only the failure messages above are available.';
  }
  const shown = trace.steps.slice(-REVIEW_TRACE_STEPS);
  const omitted = trace.totalSteps - shown.length;
  const lines = shown.map((s) => {
    const calls = s.toolCalls.map((c) => `${c.name} ${c.arguments}`).join(' | ') || '(no tool call)';
    const results = s.toolResults.map((r) => r.result).join(' | ');
    return [
      `--- turn ${s.step} ---`,
      `did: ${calls.slice(0, REVIEW_STEP_CHARS)}`,
      results ? `got: ${results.slice(0, REVIEW_STEP_CHARS)}` : '',
      s.content ? `said: ${s.content.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
  });
  return [
    omitted > 0 ? `(${omitted} earlier turns omitted; these are the last ${shown.length} of ${trace.totalSteps}.)` : '',
    ...lines,
  ].filter(Boolean).join('\n');
}

export function buildReviewPrompt(
  leaf: Leaf,
  trace: LeafTrace | null,
  sandbox?: string,
): string {
  return [
    REVIEW_PROMPT,
    '',
    '=== THE TASK ===',
    leaf.title,
    leaf.body ?? '',
    '',
    '=== HOW IT ENDED ===',
    `Status: ${leaf.status}. Attempts: ${leaf.attempts?.length ?? 0}.`,
    leaf.summary ? `The agent's final report: ${leaf.summary.slice(0, 1500)}` : '',
    '',
    '=== FAILURES ===',
    describeAttempts(leaf.attempts ?? []),
    '',
    // Included because two of the three real causes so far were environmental, and invisible from
    // the transcript alone.
    ...(sandbox ? ['=== THE ENVIRONMENT IT RAN IN ===', sandbox, ''] : []),
    '=== WHAT IT ACTUALLY DID ===',
    describeTrace(trace),
  ].filter((part) => part !== '').join('\n');
}

/** How the analysis reads in the transcript, so it is obviously a review and not a user message. */
export function formatReview(leafTitle: string, analysis: string): string {
  return `**Review of “${leafTitle}”**\n\n${analysis.trim()}`;
}

/**
 * Cuts a review off where it stops being one.
 *
 * ── THIS IS A WORKAROUND, AND FOR WHAT ──
 * The deployed model (Qwen3.6-27B) diagnoses these failures correctly and then degenerates. Its
 * opening is consistently right — "entered an infinite loop of reconnaissance commands (`git log`,
 * `npm ls`, `node --version`) instead of writing code" is exactly what the trace shows — and then
 * the sentences stop ending, the clauses pile up, and it drifts into free association. One measured
 * run finished with "menace menace menace... wait stop digression focus back task hand please thank
 * you"; another ended in emoji.
 *
 * Tried and did not fix it: reasoning on and off, ceilings of 700/900/1500/4000, temperature 0.2
 * with top_p 0.9, streamed and non-streamed. `max_tokens` is sent and the endpoint exceeds it
 * either way. So this is a property of the model on this prompt, not a setting.
 *
 * Posting six thousand characters of that into someone's conversation is worse than posting the
 * paragraph that was right, so the tail is dropped. The signature is unmistakable and local: real
 * prose has sentence endings, and degeneration is one clause welded to the next.
 *
 * Delete this the day a model that does not do it is in front of it.
 */
export const MAX_SENTENCE_CHARS = 400;
export const MAX_REVIEW_CHARS = 1600;

export function clipDegenerate(text: string): { text: string; clipped: boolean } {
  const trimmed = text.trim();
  // Sentence-ish boundaries, keeping the punctuation.
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let total = 0;
  let clipped = false;

  for (const part of parts) {
    // A "sentence" this long has not ended — it is the run-on that marks the drift starting.
    if (part.length > MAX_SENTENCE_CHARS) { clipped = true; break; }
    if (total + part.length > MAX_REVIEW_CHARS) { clipped = true; break; }
    kept.push(part);
    total += part.length + 1;
  }

  // Never return nothing: if the very first sentence is already a run-on, the opening is still the
  // useful part, so it is cut to length rather than dropped.
  if (!kept.length) return { text: trimmed.slice(0, MAX_REVIEW_CHARS), clipped: true };
  return { text: kept.join(' '), clipped };
}
