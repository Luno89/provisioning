/**
 * Running out of steps is the failure that produced nothing three times in a row — 91,818 tokens
 * on one leaf whose final commands were still `mkdir` and `write package.json`. These are the two
 * halves of that: the agent knowing the real cap, and knowing when it is nearly spent.
 */
import { describe, it, expect } from 'vitest';
import { buildAgentPrompt, MAX_AGENT_STEPS, WRAPUP_STEPS } from './sandbox-tools.js';
import { buildRepoStateScript, summariseRepoState } from './leaf-checkout.js';

describe('the cap the agent is told', () => {
  it('states the cap the loop will actually enforce', () => {
    /**
     * These were two different numbers. The prompt hardcoded the constant while the loop ran on
     * `maxSteps`, which an override can change — so raising the cap told the agent nothing and it
     * kept budgeting for 24.
     */
    // A value the constant will never be, so this keeps testing the override rather than
    // accidentally agreeing with the default — it did once, when the default was raised to 40.
    expect(buildAgentPrompt('node', 'do a thing', 99)).toContain('up to 99 steps');
    expect(buildAgentPrompt('node', 'do a thing', 99)).not.toContain(`up to ${MAX_AGENT_STEPS} steps`);
  });

  it('falls back to the shipped constant when no cap is given', () => {
    expect(buildAgentPrompt('node', 'x')).toContain(`up to ${MAX_AGENT_STEPS} steps`);
  });

  it('tells the agent uncommitted work is lost', () => {
    // The failure mode is not "ran out of time", it is "ran out of time holding everything".
    expect(buildAgentPrompt('node', 'x')).toMatch(/commit and push as you go/i);
  });

  it('leaves room to commit, push and finish', () => {
    // Warning with fewer steps left than it takes to act on the warning is just noise.
    expect(WRAPUP_STEPS).toBeGreaterThanOrEqual(3);
  });
});

describe('what a failed attempt reports', () => {
  it('asks the repository what happened, not the transcript', () => {
    const s = buildRepoStateScript();

    expect(s).toContain('git log --oneline');
    expect(s).toContain('git ls-files');
    expect(s).toContain('git status --short');
  });

  it('says plainly when nothing was committed', () => {
    // Better than a wall of empty headings, and it tells the retry to start rather than resume.
    expect(summariseRepoState('COMMITS:\nTRACKED FILES:\nUNCOMMITTED:\n'))
      .toMatch(/still empty/i);
  });

  it('passes real state through', () => {
    const out = summariseRepoState('COMMITS:\nabc1234 Add parser\nTRACKED FILES:\nsrc/index.js\n');

    expect(out).toContain('abc1234 Add parser');
    expect(out).toContain('src/index.js');
  });

  it('caps the state so it cannot flood the next prompt', () => {
    expect(summariseRepoState('COMMITS:\n' + 'x'.repeat(9000)).length).toBeLessThanOrEqual(1500);
  });

  it('returns nothing when there is no repository at all', () => {
    expect(summariseRepoState('')).toBe('');
  });
});
