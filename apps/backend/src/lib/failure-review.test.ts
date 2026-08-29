import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, REVIEW_TRACE_STEPS } from './failure-review.js';
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
    const p = buildReviewPrompt(leaf(), null);
    expect(p).toMatch(/diagnosis, not a summary/i);
    expect(p).toMatch(/least reliable/i);
  });

  it('asks explicitly whether retrying would help', () => {
    expect(buildReviewPrompt(leaf(), null)).toMatch(/retrying would help/i);
  });

  it('permits "I cannot tell"', () => {
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
    expect(buildReviewPrompt(leaf(), null)).toMatch(/No turn-by-turn record was kept/i);
  });
});

describe('how much of the trace it sees', () => {
  it('keeps the END when there are more turns than fit', () => {
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
    const p = buildReviewPrompt(leaf(), null, 'Outbound network is blocked except DNS.');
    expect(p).toContain('Outbound network is blocked');
  });

  it('keeps at most the configured number of turns', () => {
    const steps = Array.from({ length: 60 }, (_, i) => step(i + 1));
    const p = buildReviewPrompt(leaf(), trace(steps));
    expect((p.match(/--- turn /g) ?? []).length).toBe(REVIEW_TRACE_STEPS);
  });
});

describe('the review as a chat message', () => {
  it('opens as something a person is asking, not a system instruction', () => {
    expect(buildReviewPrompt(leaf(), null)).toMatch(/^One of the leaves on this branch failed/);
  });

  it('asks for a length', () => {
    expect(buildReviewPrompt(leaf(), null)).toMatch(/under 200 words/i);
  });
});
