import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, formatReview, REVIEW_TRACE_STEPS, clipDegenerate, MAX_REVIEW_CHARS } from './failure-review.js';
import type { Leaf } from './leaves.js';
import type { LeafTrace } from './leaf-trace.js';
import type { AgentStep } from '@koala/harness-types';

const leaf = (over: Record<string, unknown> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1',
  title: 'Implement the GitHub REST API HTTP client',
  body: 'Create src/github-client.js with pagination.',
  status: 'failed', column: 'todo', depth: 0, blocking: false,
  createdAt: '', updatedAt: '',
  ...over,
} as Leaf);

const step = (n: number, over: Partial<AgentStep> = {}): AgentStep => ({
  step: n, toolCalls: [], toolResults: [], tokens: 10, ...over,
});

const trace = (steps: AgentStep[], total?: number): LeafTrace => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', steps,
  totalSteps: total ?? steps.length, tokensUsed: 100, createdAt: '',
});

describe('what the reviewer is asked', () => {
  it('tells it to diagnose rather than summarise', () => {
    /**
     * The failure this guards against: every real cause here has been invisible in the agent's own
     * narration, which was confident and wrong. A reviewer that retells the story reproduces the
     * mistake.
     */
    const p = buildReviewPrompt(leaf(), null);
    expect(p).toMatch(/diagnosis, not a summary/i);
    expect(p).toMatch(/least reliable/i);
  });

  it('asks explicitly whether retrying would help', () => {
    // The decision the person is actually making when they open this.
    expect(buildReviewPrompt(leaf(), null)).toMatch(/retrying would help/i);
  });

  it('permits "I cannot tell"', () => {
    // A confident guess about a failure is worse than none — it sends the next hour the wrong way.
    expect(buildReviewPrompt(leaf(), null)).toMatch(/does not support a conclusion/i);
  });

  it('carries the task, the failures and the attempts', () => {
    const p = buildReviewPrompt(leaf({
      attempts: [{ error: 'Ran out of steps (40)' }, { error: 'Stopped calling tools' }],
      summary: 'I created both files.',
    }), null);
    expect(p).toContain('Implement the GitHub REST API HTTP client');
    expect(p).toContain('Ran out of steps (40)');
    expect(p).toContain('Attempt 2');
    expect(p).toContain('I created both files.');
  });

  it('says so when no record was kept, rather than implying nothing happened', () => {
    // Leaves that ran before traces were persisted have none, and a silent gap would read as an
    // agent that did nothing.
    expect(buildReviewPrompt(leaf(), null)).toMatch(/No turn-by-turn record was kept/i);
  });
});

describe('how much of the trace it sees', () => {
  it('keeps the END when there are more turns than fit', () => {
    /**
     * The opposite of trimTrace, which keeps the opening too — that is for STORAGE, where someone
     * may be reading to understand the approach. Here the reader already knows something is wrong,
     * and a failure lives at the end.
     */
    const steps = Array.from({ length: 40 }, (_, i) => step(i + 1, {
      toolCalls: [{ name: 'run_command', arguments: `{"command":"step-${i + 1}"}` }],
    }));
    const p = buildReviewPrompt(leaf(), trace(steps));
    expect(p).toContain('step-40');
    expect(p).not.toContain('"command":"step-1"');
    expect(p).toMatch(/earlier turns omitted/);
  });

  it('shows what a turn did and what came back', () => {
    const p = buildReviewPrompt(leaf(), trace([
      step(1, {
        toolCalls: [{ name: 'run_command', arguments: '{"command":"npm install jest"}' }],
        toolResults: [{ name: 'run_command', result: '{"stdout":"","exitCode":0}' }],
      }),
    ]));
    expect(p).toContain('npm install jest');
    expect(p).toContain('exitCode');
  });

  it('includes the environment, because that is where the causes have been', () => {
    // Two of the three real causes so far were environmental and invisible from the transcript.
    const p = buildReviewPrompt(leaf(), null, 'Outbound network is blocked except DNS.');
    expect(p).toContain('Outbound network is blocked');
  });

  it('keeps at most the configured number of turns', () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(i + 1));
    const p = buildReviewPrompt(leaf(), trace(steps));
    expect((p.match(/--- turn /g) ?? []).length).toBe(REVIEW_TRACE_STEPS);
  });
});

describe('how the review reads in the transcript', () => {
  it('is labelled as a review of the leaf it is about', () => {
    // It lands in a conversation among the user's own messages; unlabelled it reads as Koala
    // volunteering an opinion.
    expect(formatReview('Add tests', 'It ran out of room.')).toContain('Review of “Add tests”');
  });
});

describe('clipping a review that stops being one', () => {
  it('keeps a well-formed answer whole', () => {
    const good = 'The agent looped on reconnaissance. Retrying will not help. Raise the step budget.';
    expect(clipDegenerate(good)).toEqual({ text: good, clipped: false });
  });

  it('cuts at the run-on sentence where the drift starts', () => {
    /**
     * The measured signature. The opening is accurate and then the sentences stop ending — one
     * real run trailed off into "menace menace menace... wait stop digression".
     */
    const drift = `${'The agent looped on reconnaissance. '}${'clause '.repeat(120)}`;
    const out = clipDegenerate(drift);
    expect(out.clipped).toBe(true);
    expect(out.text).toBe('The agent looped on reconnaissance.');
  });

  it('still returns something when the very first sentence runs away', () => {
    // Dropping everything would turn a bad answer into no answer, and the opening is the part
    // that has consistently been right.
    const out = clipDegenerate('word '.repeat(500));
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
    expect(out.clipped).toBe(true);
  });

  it('bounds what reaches the conversation', () => {
    const many = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} about the failure.`).join(' ');
    expect(clipDegenerate(many).text.length).toBeLessThanOrEqual(MAX_REVIEW_CHARS);
  });
});
