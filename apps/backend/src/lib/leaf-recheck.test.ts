import { describe, it, expect } from 'vitest';
import { recheckVerdict, statusAfterRecheck, canRecheck, type BranchFacts } from './leaf-recheck.js';
import type { Leaf } from './leaves.js';

/**
 * Looking again at a failure whose work may be sitting on a branch.
 *
 * ── THE LINE THAT MATTERS ──
 * "There are commits on a branch" is not evidence the task was done, and promoting a leaf on that
 * basis would launder the exact claim this system is built to keep separate. Most of what follows
 * checks that the recheck REFUSES to promote when it cannot actually check anything — the failure
 * mode here is not missing a recovery, it is inventing one.
 */

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
    // No branch means nothing was ever pushed; there is nowhere to look.
    const { outputBranch, ...noBranch } = leaf();
    expect(canRecheck(noBranch as Leaf)).toBe(false);
  });
});

describe('what it refuses to do', () => {
  it('will NOT promote a leaf just because a branch has commits', () => {
    /**
     * The whole point. This is the lost leaf's exact situation — real work on a real branch — and
     * the answer is still "someone has to look", because nothing was declared that could confirm
     * the TASK was done rather than merely that files changed.
     */
    const v = recheckVerdict(leaf({ expects: [] }), facts({ commitsAhead: 4 }));
    expect(v.outcome).toBe('needs-a-look');
    expect(statusAfterRecheck(v)).toBeUndefined();
    expect(v.reason).toMatch(/nothing here can confirm/i);
    // It still reports what it found, so the person deciding has the facts.
    expect(v.reason).toContain('4 commits');
  });

  it('will not promote a part-done leaf', () => {
    // Some files there, some not. Not a pass, and not nothing — and the difference decides whether
    // a retry starts from scratch.
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
    /**
     * This is the artifact check, run late. It is the same check that would have passed at the
     * time, on the same evidence — the only thing that changed is when it was asked.
     */
    const v = recheckVerdict(
      leaf({ expects: ['test/github-client.test.js'] }),
      facts({ found: ['test/github-client.test.js'] }),
    );
    expect(v.outcome).toBe('verified');
    expect(v.reason).toMatch(/ran out of budget before it could say so/i);
    expect(statusAfterRecheck(v)).toEqual({ status: 'succeeded', verified: true, merged: false });
  });

  it('promotes to verified but NOT merged', () => {
    /**
     * Merging is a separate act with its own failure modes. Landing code on the default branch as a
     * silent side effect of a recheck would put work there that nobody asked to land — and
     * `verified` without `merged` is already a meaningful state: it holds together and is waiting
     * on a person.
     */
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
    /**
     * Learned the hard way, on the first real run: a wrong owner/repo lookup returned a 404, which
     * this reported as "the branch no longer exists" for two leaves whose branches were intact. A
     * branch that cannot be found is a deleted branch, a bad lookup, or an unreachable Gitea, and
     * they are indistinguishable from here — so it says it could not tell, which gets someone to
     * check rather than to believe.
     */
    const v = recheckVerdict(leaf({ expects: ['a.js'] }), facts({ exists: false }));
    expect(v.outcome).toBe('needs-a-look');
    expect(statusAfterRecheck(v)).toBeUndefined();
    expect(v.reason).toMatch(/could not find/i);
    expect(v.reason).not.toMatch(/no longer exists/i);
  });
});
