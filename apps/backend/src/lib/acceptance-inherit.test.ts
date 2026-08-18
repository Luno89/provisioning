import { describe, it, expect } from 'vitest';
import { inheritedAcceptance } from './acceptance-inherit.js';

/**
 * A follow-up branch starting with the acceptance plan its tree already uses.
 *
 * ── THE DEAD END ──
 * Nothing may be accepted on a branch with no acceptance plan, which is a rule worth keeping. But
 * the plan is stored per BRANCH and only the planner ever set one, during planning — so a follow-up
 * branch was born unacceptable. Measured on the live database:
 *
 *     tree 1f63acec   branch 1: acceptance=1    branch 2: acceptance=0, 1 leaf stuck
 *     tree ad8bc552   branch 1: acceptance=1    branch 2: acceptance=0, 2 leaves stuck
 *
 * Reported as "I can't click accept", because the refusal was swallowed by the UI as well.
 */

const check = (name: string) => ({ name, command: `node verify-${name}.js` });
const branch = (over: Record<string, unknown> = {}) => ({
  treeId: 't1', acceptance: [check('runs')], updatedAt: '2026-08-17T10:00:00Z', ...over,
});

describe('what a new branch inherits', () => {
  it('takes its tree\'s plan', () => {
    expect(inheritedAcceptance('t1', [branch()])).toEqual([check('runs')]);
  });

  it('takes the MOST RECENT plan, not the first', () => {
    // A tree whose acceptance was revised should hand on the revision; the oldest branch is the
    // least likely to still be right.
    const got = inheritedAcceptance('t1', [
      branch({ acceptance: [check('old')], updatedAt: '2026-08-01T00:00:00Z' }),
      branch({ acceptance: [check('new')], updatedAt: '2026-08-17T00:00:00Z' }),
    ]);
    expect(got).toEqual([check('new')]);
  });

  it('falls back to createdAt when a branch has never been updated', () => {
    const got = inheritedAcceptance('t1', [
      { treeId: 't1', acceptance: [check('only')], createdAt: '2026-08-02T00:00:00Z' },
    ]);
    expect(got).toEqual([check('only')]);
  });
});

describe('what it must NOT inherit', () => {
  it('ignores branches of other trees', () => {
    // Two efforts against two repositories have nothing to say about each other's checks.
    expect(inheritedAcceptance('t1', [branch({ treeId: 't2' })])).toEqual([]);
  });

  it('does not let an empty plan shadow a real one further back', () => {
    /**
     * The newest branch usually has no plan — it is the one being created after the one that did.
     * Sorting by recency alone would inherit its emptiness.
     */
    const got = inheritedAcceptance('t1', [
      branch({ acceptance: [check('real')], updatedAt: '2026-08-01T00:00:00Z' }),
      branch({ acceptance: [], updatedAt: '2026-08-17T00:00:00Z' }),
    ]);
    expect(got).toEqual([check('real')]);
  });

  it('ignores a plan whose checks are unusable', () => {
    // Same rule the tool applies: a command that cannot run is not a check.
    expect(inheritedAcceptance('t1', [branch({ acceptance: [{ name: 'blank', command: '   ' }] })])).toEqual([]);
  });

  it('gives nothing for a branch with no tree at all', () => {
    // An unfiled conversation has nothing to inherit from, and guessing across every tree the user
    // owns would attach one project's checks to another.
    expect(inheritedAcceptance(undefined, [branch()])).toEqual([]);
    expect(inheritedAcceptance('', [branch()])).toEqual([]);
  });

  it('gives nothing when the tree has no branches yet', () => {
    // The FIRST branch of a tree. The planner sets its plan, as it always did.
    expect(inheritedAcceptance('t1', [])).toEqual([]);
  });
});
