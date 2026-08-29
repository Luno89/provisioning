import { describe, it, expect } from 'vitest';
import { isFrontier, shouldReplan, summariseOutcomes, buildReplanPrompt, MAX_OUTCOME_CHARS } from './replan.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'do a thing', column: 'review',
  status: 'succeeded', depth: 0, blocking: true, createdAt: '', updatedAt: '', ...over,
} as Leaf);

describe('which leaf is worth replanning after', () => {
  it('is the end of a chain, not a link in one', () => {
    const first = leaf({ id: 'a' });
    const second = leaf({ id: 'b', dependsOn: ['a'] });
    expect(isFrontier(first, [first, second])).toBe(false);
    expect(isFrontier(second, [first, second])).toBe(true);
  });

  it('is nothing at all while the leaf is still running', () => {
    const running = leaf({ status: 'running' });
    expect(isFrontier(running, [running])).toBe(false);
  });

  it('counts a failed leaf', () => {
    const failed = leaf({ status: 'failed' });
    expect(isFrontier(failed, [failed])).toBe(true);
  });
});

describe('whether to spend a planning turn', () => {
  const solo = leaf({ id: 'a' });

  it('spends one on a finished frontier leaf', () => {
    expect(shouldReplan(solo, [solo], undefined, 0).replan).toBe(true);
  });

  it('waits while unrelated work on the branch is still running', () => {
    const other = leaf({ id: 'b', status: 'running' });
    const v = shouldReplan(solo, [solo, other], undefined, 0);
    expect(v.replan).toBe(false);
    expect(v.reason).toContain('still running');
  });

  it('does not wait for work that depends on this leaf', () => {
    const dependent = leaf({ id: 'b', status: 'pending', dependsOn: ['a'] });
    expect(shouldReplan(solo, [solo, dependent], undefined, 0).replan).toBe(false);
  });

  it('stops at the replan budget, and says so', () => {
    const v = shouldReplan(solo, [solo], { maxReplans: 2 }, 2);
    expect(v.replan).toBe(false);
    expect(v.reason).toContain('2/2');
  });

  it('gives a reason whenever it declines, so a silent skip is never indistinguishable from a no-op', () => {
    for (const v of [
      shouldReplan(leaf({ status: 'running' }), [], undefined, 0),
      shouldReplan(solo, [solo], { maxReplans: 1 }, 1),
    ]) {
      expect(v.replan).toBe(false);
      expect(v.reason).toBeTruthy();
    }
  });
});

describe('what the planner is shown', () => {
  const named = (id: string) => ({ p1: 'Researcher', p2: 'Builder' }[id]);

  it('carries what a leaf produced, which the board never did', () => {
    const outcomes = summariseOutcomes([
      leaf({ id: 'a', title: 'Find the licence', packId: 'p1', verified: true, findings: 'BSL 1.1' }),
      leaf({ id: 'b', title: 'Build the client', packId: 'p2', outputBranch: 'koala/b', summary: 'wrote it' }),
    ], 'b1', named);
    expect(outcomes[0]).toMatchObject({ title: 'Find the licence', verified: true, persona: 'Researcher', findings: 'BSL 1.1' });
    expect(outcomes[1]).toMatchObject({ persona: 'Builder', branch: 'koala/b', summary: 'wrote it' });
  });

  it('leaves out work that has not finished', () => {
    const outcomes = summariseOutcomes([leaf({ status: 'running' })], 'b1', named);
    expect(outcomes).toEqual([]);
  });

  it('trims an answer that would otherwise dominate the prompt', () => {
    const outcomes = summariseOutcomes([leaf({ findings: 'x'.repeat(9000) })], 'b1', named);
    expect(outcomes[0]!.findings!.length).toBe(MAX_OUTCOME_CHARS);
  });
});

describe('the turn itself', () => {
  it('asks about further work and never about completion', () => {
    const text = buildReplanPrompt('scrape prices and serve them', [
      { title: 'Scrape prices', status: 'succeeded', verified: true, persona: 'Researcher', findings: 'a table' },
    ]);
    expect(text).toContain('is any further work needed');
    expect(text).not.toMatch(/is the request (complete|finished|done)/i);
    expect(text).toContain('propose_leaf');
    expect(text).toContain('assigning a persona');
  });

  it('says whether each result was actually checked', () => {
    const text = buildReplanPrompt('x', [
      { title: 'A', status: 'succeeded', verified: false, persona: null, summary: 'claims it works' },
    ]);
    expect(text).toContain('unverified');
    expect(text).toContain('it reported:');
  });

  it('tells it not to re-propose work that already succeeded', () => {
    expect(buildReplanPrompt('x', [])).toContain('Do not re-propose');
  });
});
