import { describe, it, expect } from 'vitest';
import { buildAgentPrompt, MAX_AGENT_STEPS, WRAPUP_STEPS } from './sandbox-tools.js';
import { buildRepoStateScript, summariseRepoState } from './leaf-checkout.js';
import { WORKSPACE_IMAGE_SEEDS as IMAGES } from './workspace-image-seeds.js';

describe('the cap the agent is told', () => {
  it('states the cap the loop will actually enforce', () => {
    expect(buildAgentPrompt(IMAGES, 'node', 'do a thing', 99)).toContain('up to 99 steps');
    expect(buildAgentPrompt(IMAGES, 'node', 'do a thing', 99)).not.toContain(`up to ${MAX_AGENT_STEPS} steps`);
  });

  it('falls back to the shipped constant when no cap is given', () => {
    expect(buildAgentPrompt(IMAGES, 'node', 'x')).toContain(`up to ${MAX_AGENT_STEPS} steps`);
  });

  it('tells the agent uncommitted work is lost', () => {
    expect(buildAgentPrompt(IMAGES, 'node', 'x')).toMatch(/commit and push as you go/i);
  });

  it('leaves room to commit, push and finish', () => {
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
