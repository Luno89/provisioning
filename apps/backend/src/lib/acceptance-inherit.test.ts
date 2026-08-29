import { describe, it, expect } from 'vitest';
import { inheritedAcceptance } from './acceptance-inherit.js';

const check = (name: string) => ({ name, command: `node verify-${name}.js` });
const branch = (over: Record<string, unknown> = {}) => ({
  treeId: 't1', acceptance: [check('runs')], updatedAt: '2026-08-17T10:00:00Z', ...over,
});

describe('what a new branch inherits', () => {
  it('takes its tree\'s plan', () => {
    expect(inheritedAcceptance('t1', [branch()])).toEqual([check('runs')]);
  });

  it('takes the MOST RECENT plan, not the first', () => {
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
    expect(inheritedAcceptance('t1', [branch({ treeId: 't2' })])).toEqual([]);
  });

  it('does not let an empty plan shadow a real one further back', () => {
    const got = inheritedAcceptance('t1', [
      branch({ acceptance: [check('real')], updatedAt: '2026-08-01T00:00:00Z' }),
      branch({ acceptance: [], updatedAt: '2026-08-17T00:00:00Z' }),
    ]);
    expect(got).toEqual([check('real')]);
  });

  it('ignores a plan whose checks are unusable', () => {
    expect(inheritedAcceptance('t1', [branch({ acceptance: [{ name: 'blank', command: '   ' }] })])).toEqual([]);
  });

  it('gives nothing for a branch with no tree at all', () => {
    expect(inheritedAcceptance(undefined, [branch()])).toEqual([]);
    expect(inheritedAcceptance('', [branch()])).toEqual([]);
  });

  it('gives nothing when the tree has no branches yet', () => {
    expect(inheritedAcceptance('t1', [])).toEqual([]);
  });
});
