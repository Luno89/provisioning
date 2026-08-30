import { describe, it, expect } from 'vitest';
import { classifyOutcome, countOutcomes, attempted, claimGap, droppedValues } from './run-outcome.js';
import type { VariantResult } from '@koala/harness-types';

const run = (over: Partial<VariantResult> = {}): VariantResult => ({
  label: 'a', taskId: 't1', succeeded: true, verified: true,
  verifyExitCode: 0, verifyOutput: '', steps: 5, tokensUsed: 15000,
  durationMs: 20000, summary: 'done', transcript: [],
  ...over,
});

describe('classifyOutcome', () => {
  it('calls a run that produced nothing broken, not failed', () => {
    const dead = run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0, error: 'fetch failed' });
    expect(classifyOutcome(dead)).toBe('broken');
  });

  it('calls it broken on zero work even when nothing recorded an error', () => {
    expect(classifyOutcome(run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0 }))).toBe('broken');
  });

  it('prefers broken over wrong when a failed run also errored', () => {
    const both = run({ verified: false, succeeded: false, steps: 3, tokensUsed: 900, error: 'terminated' });
    expect(classifyOutcome(both)).toBe('broken');
  });

  it('separates running out of steps from being wrong', () => {
    const capped = run({
      verified: false, succeeded: false, steps: 24,
      request: { systemPrompt: '', kickoff: '', tools: [], parameters: {}, loop: { maxSteps: 24, think: false, toolResultCap: 8000 } },
    });
    expect(classifyOutcome(capped)).toBe('incomplete');
  });

  it('does not call a short wrong answer incomplete', () => {
    const wrong = run({
      verified: false, succeeded: true, steps: 6,
      request: { systemPrompt: '', kickoff: '', tools: [], parameters: {}, loop: { maxSteps: 24, think: false, toolResultCap: 8000 } },
    });
    expect(classifyOutcome(wrong)).toBe('wrong');
  });

  it('will not guess at exhaustion when the cap was never recorded', () => {
    expect(classifyOutcome(run({ verified: false, succeeded: false, steps: 40 }))).toBe('wrong');
  });

  it('counts a verified run as verified even if it also ran long', () => {
    const capped = run({
      verified: true, succeeded: false, steps: 24,
      request: { systemPrompt: '', kickoff: '', tools: [], parameters: {}, loop: { maxSteps: 24, think: false, toolResultCap: 8000 } },
    });
    expect(classifyOutcome(capped)).toBe('verified');
  });
});

describe('the denominator', () => {
  it('drops broken runs so a score is over fair attempts', () => {
    const results = [
      run({ verified: true }), run({ verified: true }),
      ...Array.from({ length: 13 }, () =>
        run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0, error: 'fetch failed' })),
    ];
    const fair = attempted(results);

    expect(fair).toHaveLength(2);
    expect(fair.filter((r) => r.verified)).toHaveLength(2);
    expect(countOutcomes(results)).toEqual({ verified: 2, wrong: 0, incomplete: 0, broken: 13 });
  });
});

describe('claimGap', () => {
  it('reports underclaiming, which nothing was reporting', () => {
    const results = Array.from({ length: 4 }, () => run({ verified: true, succeeded: false }));
    const { overclaimed, underclaimed } = claimGap(results);

    expect(underclaimed).toHaveLength(4);
    expect(overclaimed).toHaveLength(0);
  });

  it('still reports overclaiming', () => {
    const { overclaimed } = claimGap([run({ verified: false, succeeded: true, steps: 4 })]);
    expect(overclaimed).toHaveLength(1);
  });

  it('ignores broken runs, which claimed nothing about anything', () => {
    const dead = run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0, error: 'x' });
    const gap = claimGap([dead]);
    expect(gap.overclaimed).toHaveLength(0);
    expect(gap.underclaimed).toHaveLength(0);
  });
});

describe('droppedValues', () => {
  const request = (over: Record<string, unknown>) => ({
    systemPrompt: '', kickoff: '', tools: [], parameters: {}, ...over,
  }) as NonNullable<VariantResult['request']>;

  it('catches a knob that was asked for and never sent', () => {
    const r = run({ request: request({ ranAs: { packId: 'p', slug: 's', packUpdatedAt: '', budget: {} as never, sampling: { toolTurn: { temperature: 0.7 }, conversation: {} } }, parameters: {} }) });
    expect(droppedValues(r)).toEqual(['temperature']);
  });

  it('accepts a knob that reached the wire', () => {
    const r = run({ request: request({ ranAs: { packId: 'p', slug: 's', packUpdatedAt: '', budget: {} as never, sampling: { toolTurn: { temperature: 0.7 }, conversation: {} } }, parameters: { temperature: 0.7 } }) });
    expect(droppedValues(r)).toEqual([]);
  });

  it('accepts a knob renamed on the wire', () => {
    const r = run({
      request: request({ overrides: { think: true }, parameters: { template_vars: { enable_thinking: true } } }),
    });
    expect(droppedValues(r)).toEqual([]);
  });

  it('accepts a knob the loop reads instead of sending', () => {
    const r = run({
      request: request({ overrides: { maxSteps: 30 }, loop: { maxSteps: 30, think: false, toolResultCap: 8000 } }),
    });
    expect(droppedValues(r)).toEqual([]);
  });

  it('does not flag a knob dropped deliberately for the engine', () => {
    const r = run({
      request: request({ overrides: { dry_multiplier: 0.8 }, parameters: {}, unsupported: ['dry_multiplier'] }),
    });
    expect(droppedValues(r)).toEqual([]);
  });

  it('says nothing about a run that recorded no request', () => {
    expect(droppedValues(run({}))).toEqual([]);
  });
});

/**
 * A `describe` here once checked that a prompt override reached the prompt. There is no gap left
 * for it to catch: the persona's prompt is passed to the loop as its own argument and recorded
 * verbatim beside the run, so "asked for but never sent" is only expressible about the sampler now.
 * agent-loop.test.ts pins the prompt itself.
 */
