import { describe, it, expect } from 'vitest';
import {
  shouldCheckpoint, buildCheckpointArtifact, parseHandoff, assembleResetPrompt,
  HANDOFF_TOOL, CHECKPOINTS,
} from './leaf-checkpoint.js';

describe('when a run stops to write itself down', () => {
  const at = (tokensUsed: number, taken = 0) => shouldCheckpoint({ tokensUsed, maxTokens: 300, taken });

  it('does not fire at the start of a run', () => {
    expect(at(0)).toBe(false);
    expect(at(50)).toBe(false);
  });

  it('fires once budget crosses each slice', () => {
    // Two checkpoints means thirds: at 100 and at 200 of 300.
    expect(at(99)).toBe(false);
    expect(at(100)).toBe(true);
    expect(at(150, 1)).toBe(false);
    expect(at(200, 1)).toBe(true);
  });

  it('stops after the last one, however long the run goes on', () => {
    expect(at(299, CHECKPOINTS)).toBe(false);
  });

  /**
   * The forced wrap-up at the end of the loop already asks the agent for an account of itself,
   * through the same one-tool mechanism. Firing here would pay for two near-identical turns and
   * reset a context that is about to be abandoned.
   */
  it('does not fire when the budget is nearly gone', () => {
    expect(shouldCheckpoint({ tokensUsed: 290, maxTokens: 300, taken: 1 })).toBe(false);
  });

  it('refuses to divide by a budget that is not one', () => {
    expect(shouldCheckpoint({ tokensUsed: 10, maxTokens: 0, taken: 0 })).toBe(false);
    expect(shouldCheckpoint({ tokensUsed: 10, maxTokens: Number.NaN, taken: 0 })).toBe(false);
  });

  /**
   * The abandoned harness-v2 branch computed its trigger as `turnIndex % 15` against a threshold of
   * 15, so the condition could never be true. It reads like it counts something, which is what made
   * it survive review. Asserted here so this one is measurably reachable.
   */
  it('is actually reachable across a whole run, unlike a modulo against its own period', () => {
    let taken = 0;
    for (let used = 0; used <= 300; used += 10) {
      if (shouldCheckpoint({ tokensUsed: used, maxTokens: 300, taken })) taken++;
    }
    expect(taken).toBe(CHECKPOINTS);
  });
});

describe('the agent’s half of the artifact', () => {
  it('offers exactly one tool, and it is not finish', () => {
    // Withholding every other tool is what makes this a pause rather than another working turn.
    expect(HANDOFF_TOOL.function.name).toBe('handoff');
    expect(HANDOFF_TOOL.function.parameters.required).toEqual(['done', 'next']);
  });

  it('reads a handoff', () => {
    const h = parseHandoff({ done: 'wrote the parser', next: 'wire it to the route', learned: 'no network' });
    expect(h).toMatchObject({ done: 'wrote the parser', next: 'wire it to the route', learned: 'no network' });
  });

  it('accepts a partial one rather than throwing it away', () => {
    // Half an account is far better than none at the moment a context is about to be discarded.
    expect(parseHandoff({ done: 'wrote the parser' })).toMatchObject({ done: 'wrote the parser', next: '(not stated)' });
  });

  it('returns nothing when there is nothing there', () => {
    expect(parseHandoff({})).toBeUndefined();
    expect(parseHandoff({ done: '   ' })).toBeUndefined();
  });

  it('bounds every field, because this lands in a file and in the next prompt', () => {
    const h = parseHandoff({ done: 'x'.repeat(50_000), next: 'y'.repeat(50_000) })!;
    expect(h.done.length).toBeLessThan(3_000);
    expect(h.next.length).toBeLessThan(3_000);
  });
});

describe('the artifact itself', () => {
  const base = {
    number: 1, taskTitle: 'Add a rate limiter', at: '2026-08-21T00:00:00.000Z',
    tokensUsed: 100_000, maxTokens: 300_000,
  };

  it('separates what was checked from what the agent claimed', () => {
    const out = buildCheckpointArtifact({
      ...base,
      handoff: { done: 'token bucket written', next: 'add the middleware' },
      repo: { branch: 'koala/abc', commits: 'a1b2c3 add bucket', changed: ' 2 files changed' },
      verify: { outcome: 'passed', output: 'ok' },
    });

    expect(out).toContain('What the agent says is done');
    expect(out).toContain('token bucket written');
    expect(out).toContain('What is actually committed');
    expect(out).toContain('a1b2c3 add bucket');
    // A reader must be able to tell a claim from a check, which is the whole point of the split.
    expect(out.indexOf('What the agent says')).toBeLessThan(out.indexOf('What is actually committed'));
  });

  it('says the handoff turn failed rather than omitting the section', () => {
    // A missing section reads as "nothing to report", which is a different and wrong claim.
    const out = buildCheckpointArtifact({ ...base, repo: { branch: 'b', commits: '', changed: '' } });
    expect(out).toContain('did not produce an answer');
  });

  it('describes a deliverable instead of a checkout for a persona with no repo', () => {
    const out = buildCheckpointArtifact({
      ...base,
      findings: { path: '/work/findings.md', outcome: 'unverified', reason: 'No sources cited yet.', chars: 900 },
    });

    expect(out).toContain('/work/findings.md');
    expect(out).toContain('unverified');
    // This is more useful than a git summary would be: it names which check currently fails.
    expect(out).toContain('No sources cited yet.');
    expect(out).not.toContain('What is actually committed');
  });

  it('lists declared artifacts that are still missing', () => {
    const out = buildCheckpointArtifact({ ...base, missing: ['src/limiter.ts'] });
    expect(out).toContain('src/limiter.ts');
  });

  it('bounds a runaway section rather than writing it whole', () => {
    const out = buildCheckpointArtifact({
      ...base,
      repo: { branch: 'b', commits: 'x'.repeat(100_000), changed: '' },
    });
    expect(out).toContain('[trimmed]');
    expect(out.length).toBeLessThan(10_000);
  });
});

describe('what the agent is told after a reset', () => {
  it('explains that it happened, and carries the artifact in full', () => {
    /**
     * An agent that finds its context inexplicably shorter spends turns re-establishing things it
     * already knew. Saying so is cheaper than letting it work that out.
     */
    const out = assembleResetPrompt('Add a rate limiter', '# Checkpoint 1\nthe artifact body');
    expect(out).toContain('was reset');
    expect(out).toContain('Nothing you did was');
    expect(out).toContain('the artifact body');
    expect(out).toContain('Do not redo work that is already committed');
  });
});
