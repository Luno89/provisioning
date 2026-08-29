import { describe, it, expect } from 'vitest';
import { recheckVerdict, statusAfterRecheck, canRecheck, type BranchFacts } from './leaf-recheck.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'l1', ownerId: 'u1', branchId: 'b1', title: 'Write the tests',
  column: 'todo', status: 'failed', depth: 0, blocking: true,
  createdAt: '', updatedAt: '', outputBranch: 'koala/7565dc49',
  ...over,
} as Leaf);

const facts = (over: Partial<BranchFacts> = {}): BranchFacts =>
  ({ exists: true, found: [], missing: [], ...over });

describe('when a recheck is worth doing at all', () => {
  it('only for a failure that pushed something', () => {
    expect(canRecheck(leaf())).toBe(true);
    expect(canRecheck(leaf({ status: 'succeeded' }))).toBe(false);
    const { outputBranch, ...noBranch } = leaf();
    expect(canRecheck(noBranch as Leaf)).toBe(false);
  });
});

describe('what it refuses to do', () => {
  it('will NOT promote a leaf just because a branch has commits', () => {
    const v = recheckVerdict(leaf({ expects: [] }), facts({ commitsAhead: 4 }));
    expect(v.outcome).toBe('needs-a-look');
    expect(statusAfterRecheck(v)).toBeUndefined();
    expect(v.reason).toMatch(/nothing here can confirm/i);
    expect(v.reason).toContain('4 commits');
  });

  it('will not promote a part-done leaf', () => {
    const v = recheckVerdict(
      leaf({ expects: ['test/a.test.js', 'test/b.test.js'] }),
      facts({ found: ['test/a.test.js'], missing: ['test/b.test.js'] }),
    );
    expect(v.outcome).toBe('needs-a-look');
    expect(statusAfterRecheck(v)).toBeUndefined();
    expect(v.reason).toContain('part-done');
  });

  it('leaves a leaf that is not failed alone', () => {
    expect(recheckVerdict(leaf({ status: 'succeeded' }), facts()).outcome).toBe('not-applicable');
  });
});

describe('what it will do', () => {
  it('promotes a leaf whose promised files are all on the branch', () => {
    const v = recheckVerdict(
      leaf({ expects: ['test/github-client.test.js'] }),
      facts({ found: ['test/github-client.test.js'] }),
    );
    expect(v.outcome).toBe('verified');
    expect(v.reason).toMatch(/ran out of budget before it could say so/i);
    expect(statusAfterRecheck(v)).toEqual({ status: 'succeeded', verified: true, merged: false });
  });

  it('promotes to verified but NOT merged', () => {
    const v = recheckVerdict(leaf({ expects: ['a.js'] }), facts({ found: ['a.js'] }));
    expect(statusAfterRecheck(v)).toMatchObject({ merged: false });
  });

  it('says still-failed when the promised files are genuinely absent', () => {
    const v = recheckVerdict(
      leaf({ expects: ['src/client.js'] }),
      facts({ missing: ['src/client.js'] }),
    );
    expect(v.outcome).toBe('still-failed');
    expect(statusAfterRecheck(v)).toBeUndefined();
  });

  it('does NOT call a missing branch a failure', () => {
    const v = recheckVerdict(leaf({ expects: ['a.js'] }), facts({ exists: false }));
    expect(v.outcome).toBe('needs-a-look');
    expect(statusAfterRecheck(v)).toBeUndefined();
    expect(v.reason).toMatch(/could not find/i);
    expect(v.reason).not.toMatch(/no longer exists/i);
  });
});
