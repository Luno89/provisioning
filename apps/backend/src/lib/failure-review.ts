import type { Leaf, LeafAttempt } from './leaves.js';
import type { LeafTrace } from './leaf-trace.js';

export const REVIEW_TRACE_STEPS = 14;
export const REVIEW_STEP_CHARS = 600;

export const REVIEW_PROMPT = [
  'One of the leaves on this branch failed. Read the record below and tell me why.',
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
  '',
  'Keep it under 200 words. Stop when you have answered the three questions.',
].join('\n');

function describeAttempts(attempts: LeafAttempt[]): string {
  if (!attempts.length) return 'No previous attempts were recorded.';
  return attempts
    .map((a, i) => `Attempt ${i + 1}: ${String((a as { error?: string }).error ?? (a as { summary?: string }).summary ?? 'no reason recorded').slice(0, 700)}`)
    .join('\n');
}

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
    ...(sandbox ? ['=== THE ENVIRONMENT IT RAN IN ===', sandbox, ''] : []),
    '=== WHAT IT ACTUALLY DID ===',
    describeTrace(trace),
  ].filter((part) => part !== '').join('\n');
}
