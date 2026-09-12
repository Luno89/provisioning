import { describe, it, expect } from 'vitest';
import {
  applyModelResult,
  budgetExceeded,
  createRunState,
  recordChildOutcome,
  recordToolOutcome,
  settle,
  type RunIdentity,
} from './run.js';
import type { ModelCallResult } from './model-call.js';

const reply = (over: Partial<ModelCallResult> = {}): ModelCallResult => ({
  content: 'hello',
  thinking: '',
  toolCalls: [],
  usage: undefined,
  finishReason: 'stop',
  unsupported: [],
  interrupted: undefined,
  ...over,
});

const identity = (over: Partial<RunIdentity> = {}): RunIdentity => ({
  runId: 'run-1',
  depth: 0,
  agentId: 'planner',
  loopId: 'interactive',
  loopVersion: '1',
  trigger: 'user',
  ...over,
});

describe('run state', () => {
  it('starts empty', () => {
    const state = createRunState(1_000);
    expect(state.counters.rounds).toBe(0);
    expect(state.reply.content).toBe('');
    expect(state.tools).toEqual([]);
    expect(state.children).toEqual([]);
  });

  it('replaces the reply and accumulates counters across rounds', () => {
    const state = createRunState(1_000);

    applyModelResult(state, reply({ content: 'first', usage: { total_tokens: 10, completion_tokens: 4, prompt_tokens: 6 } }), 1_500);
    applyModelResult(state, reply({ content: 'second', usage: { total_tokens: 5, completion_tokens: 2, prompt_tokens: 3 } }), 2_000);

    expect(state.reply.content).toBe('second');
    expect(state.counters.rounds).toBe(2);
    expect(state.counters.totalTokens).toBe(15);
    expect(state.counters.completionTokens).toBe(6);
    expect(state.counters.promptTokens).toBe(9);
    expect(state.counters.elapsedMs).toBe(1_000);
  });

  it('treats missing or non-numeric usage as zero rather than NaN', () => {
    const state = createRunState(0);
    applyModelResult(state, reply({ usage: undefined }), 0);
    applyModelResult(state, reply({ usage: { total_tokens: 'lots' } as unknown as Record<string, unknown> }), 0);

    expect(state.counters.totalTokens).toBe(0);
    expect(Number.isNaN(state.counters.totalTokens)).toBe(false);
  });

  it('records tool and child outcomes with their counters', () => {
    const state = createRunState(0);
    recordToolOutcome(state, { callId: 'c1', name: 'read_file', ok: true, digest: 'contents' }, 0);
    recordChildOutcome(state, { runId: 'run-2', agentId: 'research', outcome: 'ok', outputs: { findings: 'x' } }, 0);

    expect(state.counters.toolCalls).toBe(1);
    expect(state.counters.childRuns).toBe(1);
    expect(state.tools[0]?.name).toBe('read_file');
    expect(state.children[0]?.agentId).toBe('research');
  });
});

describe('budgetExceeded', () => {
  it('passes when everything is within budget', () => {
    const state = createRunState(0);
    applyModelResult(state, reply({ usage: { total_tokens: 5 } }), 0);

    expect(budgetExceeded(state, { maxRounds: 4, maxTokens: 100 }, identity(), 0)).toBeUndefined();
  });

  it('catches the round limit', () => {
    const state = createRunState(0);
    applyModelResult(state, reply(), 0);
    applyModelResult(state, reply(), 0);

    expect(budgetExceeded(state, { maxRounds: 2 }, identity(), 0)).toMatch(/all 2 rounds/);
  });

  it('catches the token limit', () => {
    const state = createRunState(0);
    applyModelResult(state, reply({ usage: { total_tokens: 900 } }), 0);

    expect(budgetExceeded(state, { maxTokens: 500 }, identity(), 0)).toMatch(/900 tokens/);
  });

  it('catches tool-call and child-run limits', () => {
    const state = createRunState(0);
    recordToolOutcome(state, { callId: 'c', name: 't', ok: true, digest: '' }, 0);
    recordChildOutcome(state, { runId: 'r', agentId: 'a', outcome: 'ok', outputs: {} }, 0);

    expect(budgetExceeded(state, { maxToolCalls: 1 }, identity(), 0)).toMatch(/tool calls/);
    expect(budgetExceeded(state, { maxChildRuns: 1 }, identity(), 0)).toMatch(/sub-agents/);
  });

  it('catches wall-clock overrun', () => {
    const state = createRunState(0);
    expect(budgetExceeded(state, { maxWallClockMs: 30_000 }, identity(), 31_000)).toMatch(/past the limit of 30s/);
  });

  it('catches delegation depth before anything else', () => {
    const state = createRunState(0);
    expect(budgetExceeded(state, { maxDepth: 3, maxRounds: 1 }, identity({ depth: 4 }), 0)).toMatch(/4 deep/);
  });
});

describe('settle', () => {
  it('builds a result envelope carrying outputs and counters', () => {
    const state = createRunState(0);
    state.outputs = { findings: 'the thing' };
    applyModelResult(state, reply(), 0);

    const result = settle(identity(), state, 'ok');

    expect(result).toMatchObject({ runId: 'run-1', outcome: 'ok', outputs: { findings: 'the thing' } });
    expect(result.counters.rounds).toBe(1);
    expect(result.reason).toBeUndefined();
  });

  it('carries a reason when one is given', () => {
    const state = createRunState(0);
    expect(settle(identity(), state, 'exhausted', 'used all 4 rounds').reason).toBe('used all 4 rounds');
  });
});
