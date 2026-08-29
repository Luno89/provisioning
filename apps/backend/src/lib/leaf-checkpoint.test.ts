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
    expect(at(99)).toBe(false);
    expect(at(100)).toBe(true);
    expect(at(150, 1)).toBe(false);
    expect(at(200, 1)).toBe(true);
  });

  it('stops after the last one, however long the run goes on', () => {
    expect(at(299, CHECKPOINTS)).toBe(false);
  });

  it('does not fire when the budget is nearly gone', () => {
    expect(shouldCheckpoint({ tokensUsed: 290, maxTokens: 300, taken: 1 })).toBe(false);
  });

  it('refuses to divide by a budget that is not one', () => {
    expect(shouldCheckpoint({ tokensUsed: 10, maxTokens: 0, taken: 0 })).toBe(false);
    expect(shouldCheckpoint({ tokensUsed: 10, maxTokens: Number.NaN, taken: 0 })).toBe(false);
  });

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
    expect(HANDOFF_TOOL.function.name).toBe('handoff');
    expect(HANDOFF_TOOL.function.parameters.required).toEqual(['done', 'next']);
  });

  it('reads a handoff', () => {
    const h = parseHandoff({ done: 'wrote the parser', next: 'wire it to the route', learned: 'no network' });
    expect(h).toMatchObject({ done: 'wrote the parser', next: 'wire it to the route', learned: 'no network' });
  });

  it('accepts a partial one rather than throwing it away', () => {
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
    expect(out.indexOf('What the agent says')).toBeLessThan(out.indexOf('What is actually committed'));
  });

  it('says the handoff turn failed rather than omitting the section', () => {
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
    const out = assembleResetPrompt('Add a rate limiter', '# Checkpoint 1\nthe artifact body');
    expect(out).toContain('was reset');
    expect(out).toContain('Nothing you did was');
    expect(out).toContain('the artifact body');
    expect(out).toContain('Do not redo work that is already committed');
  });
});
