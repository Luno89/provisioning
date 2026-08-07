/**
 * These are written against runs that actually happened, not invented ones. Every case below has a
 * date: the OOMKill that produced thirteen phantom failures, and the arm that verified 4/4 while
 * claiming 0/4 because it kept working past its step cap.
 */
import { describe, it, expect } from 'vitest';
import { classifyOutcome, countOutcomes, attempted, claimGap, droppedOverrides } from './run-outcome.js';
import type { VariantResult } from '@koala/harness-types';

const run = (over: Partial<VariantResult> = {}): VariantResult => ({
  label: 'a', taskId: 't1', succeeded: true, verified: true,
  verifyExitCode: 0, verifyOutput: '', steps: 5, tokensUsed: 15000,
  durationMs: 20000, summary: 'done', transcript: [],
  ...over,
});

describe('classifyOutcome', () => {
  it('calls a run that produced nothing broken, not failed', () => {
    // The exact signature of the thirteen: the model server was OOMKilled and no turn completed.
    const dead = run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0, error: 'fetch failed' });
    expect(classifyOutcome(dead)).toBe('broken');
  });

  it('calls it broken on zero work even when nothing recorded an error', () => {
    // A killed process does not always get to write its own reason down.
    expect(classifyOutcome(run({ verified: false, succeeded: false, steps: 0, tokensUsed: 0 }))).toBe('broken');
  });

  it('prefers broken over wrong when a failed run also errored', () => {
    // Counting a harness outage as a failed answer is how an outage enters a variant's score.
    const both = run({ verified: false, succeeded: false, steps: 3, tokensUsed: 900, error: 'terminated' });
    expect(classifyOutcome(both)).toBe('broken');
  });

  it('separates running out of steps from being wrong', () => {
    // The arm that verified 4/4 and claimed 0/4 — correct work, never declared done. Read as a
    // boolean it looks like a failing arm; it was a step budget set too low.
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
    // Inferring it from a step count with nothing to compare against would relabel every long run.
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
    // "2/15" was the reading that nearly stood. It is 2/2, with thirteen not run.
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
    // Verified 4/4, claimed 0/4. The work was right and the agent could not tell.
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

describe('droppedOverrides', () => {
  const request = (over: Record<string, unknown>) => ({
    systemPrompt: '', kickoff: '', tools: [], parameters: {}, ...over,
  }) as NonNullable<VariantResult['request']>;

  it('catches a knob that was asked for and never sent', () => {
    // The dead `temperature` axis: declared, offered in the picker, never on the wire.
    const r = run({ request: request({ overrides: { temperature: 0.7 }, parameters: {} }) });
    expect(droppedOverrides(r)).toEqual(['temperature']);
  });

  it('accepts a knob that reached the wire', () => {
    const r = run({ request: request({ overrides: { temperature: 0.7 }, parameters: { temperature: 0.7 } }) });
    expect(droppedOverrides(r)).toEqual([]);
  });

  it('accepts a knob renamed on the wire', () => {
    // `think` travels as enable_thinking, nested — sent at the top level it is silently ignored.
    const r = run({
      request: request({ overrides: { think: true }, parameters: { template_vars: { enable_thinking: true } } }),
    });
    expect(droppedOverrides(r)).toEqual([]);
  });

  it('accepts a knob the loop reads instead of sending', () => {
    const r = run({
      request: request({ overrides: { maxSteps: 30 }, loop: { maxSteps: 30, think: false, toolResultCap: 8000 } }),
    });
    expect(droppedOverrides(r)).toEqual([]);
  });

  it('does not flag a knob dropped deliberately for the engine', () => {
    // Engine-gated knobs are dropped on purpose and the request already says so.
    const r = run({
      request: request({ overrides: { dry_multiplier: 0.8 }, parameters: {}, unsupported: ['dry_multiplier'] }),
    });
    expect(droppedOverrides(r)).toEqual([]);
  });

  it('says nothing about a run that recorded no request', () => {
    // Runs from before requests were captured must not all read as silently broken.
    expect(droppedOverrides(run({}))).toEqual([]);
  });
});

describe('prompt-placement knobs are delivered as text', () => {
  it('accepts extraInstructions appended to the prompt', () => {
    // The false positive this rule exists for: reported as never delivered across a 40-run suite
    // while the recorded prompt ended with it verbatim.
    const instruction = 'Call finish immediately after verifying your work.';
    const r = run({
      request: {
        systemPrompt: `You are an agent.\n\n${instruction}`,
        kickoff: '', tools: [], parameters: {},
        overrides: { extraInstructions: instruction },
      },
    });
    expect(droppedOverrides(r)).toEqual([]);
  });

  it('still flags a prompt override that never made it into the prompt', () => {
    const r = run({
      request: {
        systemPrompt: 'the generated prompt, unchanged',
        kickoff: '', tools: [], parameters: {},
        overrides: { systemPrompt: 'THE REPLACEMENT NOBODY SENT' },
      },
    });
    expect(droppedOverrides(r)).toEqual(['systemPrompt']);
  });
});
