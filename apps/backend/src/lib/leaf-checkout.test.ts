/**
 * The old checkout script was three obviously-correct-looking lines that threw away every
 * dependency's work. It typechecked, it ran, it succeeded, and the leaf that depended on it burned
 * its whole budget rebuilding what already existed. Nothing but reading the generated script — or
 * a live run — could show it, which is why the script is a value here rather than a string inline
 * in the activity.
 */
import { describe, it, expect } from 'vitest';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, buildPushScript, parsePushedBranch,
} from './leaf-checkout.js';
import type { Leaf } from './leaves.js';

const leaf = (over: Partial<Leaf> = {}): Leaf => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  ownerId: 'u1', branchId: 'b1', title: 't', body: '', column: 'todo',
  status: 'succeeded', depth: 0, blocking: true,
  createdAt: '', updatedAt: '', ...over,
} as Leaf);

const script = (bases: string[]) => buildCheckoutScript({
  cloneUrl: 'https://x:y@gitea/r.git', cleanUrl: 'https://gitea/r.git',
  branch: 'koala/deadbeef', baseBranches: bases,
});

describe('branch naming', () => {
  it('is deterministic, so a retry reuses the branch instead of forking one', () => {
    expect(branchNameFor('aaaaaaaa-1111')).toBe(branchNameFor('aaaaaaaa-1111'));
    expect(branchNameFor('aaaaaaaa-1111')).toBe('koala/aaaaaaaa');
  });
});

describe('which branches a leaf builds on', () => {
  it('takes the branches its dependencies actually pushed, in order', () => {
    const a = leaf({ id: 'a', outputBranch: 'koala/aaaaaaaa' });
    const b = leaf({ id: 'b', outputBranch: 'koala/bbbbbbbb' });

    expect(baseBranchesFor({ dependsOn: ['a', 'b'] }, [a, b]))
      .toEqual(['koala/aaaaaaaa', 'koala/bbbbbbbb']);
  });

  it('skips a dependency that pushed nothing', () => {
    /**
     * Reads `outputBranch` rather than recomputing the name from the id, and this is the case
     * where they differ: a dependency can succeed without producing a branch (it researched, or
     * decided there was nothing to do). Checking out a name that was never pushed is an error;
     * skipping it is correct.
     */
    const a = leaf({ id: 'a' });
    const b = leaf({ id: 'b', outputBranch: 'koala/bbbbbbbb' });

    expect(baseBranchesFor({ dependsOn: ['a', 'b'] }, [a, b])).toEqual(['koala/bbbbbbbb']);
  });

  it('returns nothing when the leaf depends on nothing', () => {
    expect(baseBranchesFor({}, [])).toEqual([]);
  });

  it('drops a branch name it could not have minted', () => {
    // outputBranch is stored data interpolated into a shell script. There is no legitimate way for
    // a name like this to appear, so it is dropped rather than escaped.
    const evil = leaf({ id: 'a', outputBranch: 'koala/aaaaaaaa; rm -rf /' });
    expect(baseBranchesFor({ dependsOn: ['a'] }, [evil])).toEqual([]);
  });

  it('does not list the same branch twice', () => {
    const a = leaf({ id: 'a', outputBranch: 'koala/aaaaaaaa' });
    const b = leaf({ id: 'b', outputBranch: 'koala/aaaaaaaa' });
    expect(baseBranchesFor({ dependsOn: ['a', 'b'] }, [a, b])).toEqual(['koala/aaaaaaaa']);
  });
});

describe('the checkout script', () => {
  it('starts from the dependency branch, not the default one', () => {
    // The whole bug, in one assertion. The old script ran `git checkout -b <new>` straight after
    // clone, which silently based every leaf on the default branch.
    const s = script(['koala/aaaaaaaa']);

    expect(s).toContain('git checkout -B "$1" "origin/$b"');
    expect(s).toContain('for b in koala/aaaaaaaa; do');
  });

  it('fetches every branch, because a clone does not include them', () => {
    // A dependency's branch is not in the default branch's history, so without this the checkout
    // below can never resolve it.
    expect(script(['koala/aaaaaaaa'])).toContain('git fetch');
  });

  it('falls back to the default branch when no dependency pushed', () => {
    const s = script([]);

    expect(s).toContain('if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi');
    expect(s).not.toContain('for b in');
  });

  it('still cuts a branch when every named base is missing', () => {
    // The loop can skip everything at runtime. Without the STARTED fallback the leaf would run
    // with no branch checked out and push nothing.
    const s = script(['koala/aaaaaaaa']);
    expect(s).toContain('STARTED=0');
    expect(s).toContain('if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi');
  });

  it('merges a second dependency rather than ignoring it', () => {
    const s = script(['koala/aaaaaaaa', 'koala/bbbbbbbb']);
    expect(s).toContain('git merge --no-edit "origin/$b"');
  });

  it('abandons a conflicted merge instead of leaving the index half-applied', () => {
    // An agent handed a conflicted index tends to commit it, which corrupts the branch every
    // later leaf builds on.
    expect(script(['koala/a1111111', 'koala/b2222222'])).toContain('git merge --abort');
  });

  it('skips a base branch that was never pushed instead of failing', () => {
    const s = script(['koala/aaaaaaaa']);
    expect(s).toContain('git rev-parse --verify --quiet "origin/$b"');
    expect(s).toContain('continue');
  });

  it('keeps the credential out of .git/config', () => {
    const s = script([]);
    expect(s).toContain('git remote set-url origin "$2"');
    expect(s).toContain('credential.helper store');
  });

  it('passes every value positionally rather than interpolating it', () => {
    // The clone URL carries a live push token, and the branch name is derived from stored data.
    // Neither belongs in the script text.
    const s = script([]);
    expect(s).not.toContain('gitea/r.git');
    expect(s).not.toContain('koala/deadbeef');
  });
});

describe('the push-back script', () => {
  it('commits and pushes work the agent left behind', () => {
    // Committed-but-unpushed is the original failure arriving one step later: the work is in a pod
    // that is about to be destroyed.
    const s = buildPushScript('koala/deadbeef');
    expect(s).toContain('git commit');
    expect(s).toContain('git push -u origin HEAD');
  });

  it('reports the branch only when the remote confirms it', () => {
    // Recorded from what the remote has, never from the agent's claim — an outputBranch nothing
    // can check out would strand every dependent leaf.
    expect(buildPushScript('koala/deadbeef')).toContain('git ls-remote --heads origin');
  });

  it('reads the branch back out of the output', () => {
    expect(parsePushedBranch('some noise\nPUSHED:koala/deadbeef\n')).toBe('koala/deadbeef');
  });

  it('reports nothing when the push never landed', () => {
    expect(parsePushedBranch('fatal: could not read Username\n')).toBeUndefined();
  });
});
