/**
 * The old checkout script was three obviously-correct-looking lines that threw away every
 * dependency's work. It typechecked, it ran, it succeeded, and the leaf that depended on it burned
 * its whole budget rebuilding what already existed. Nothing but reading the generated script — or
 * a live run — could show it, which is why the script is a value here rather than a string inline
 * in the activity.
 */
import { describe, it, expect } from 'vitest';
import {
  branchNameFor, baseBranchesFor, buildCheckoutScript, buildPushScript, parsePushedBranch, buildMergeScript, parseMergeResult, checkpointPath, buildCheckpointScript, parseCheckpointResult, buildProgressScript, parseProgress,
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

describe('resuming a failed attempt', () => {
  it('starts from this leaf\'s own branch before its dependencies', () => {
    /**
     * The retry design says attempt N+1 reads what attempt N changed. That was true of the failure
     * log and false of the work: the pod was destroyed and the next attempt cloned an empty
     * repository. Measured on one leaf — three attempts, 91,818 tokens, and every attempt's last
     * commands were still `mkdir` and `write package.json`, because it rebuilt the scaffolding
     * from nothing each time.
     *
     * Own branch first because it was itself cut from the dependencies, so it already contains
     * their work; theirs stay in the list only in case the earlier attempt never pushed.
     */
    const s = buildCheckoutScript({
      cloneUrl: 'u', cleanUrl: 'c', branch: 'koala/deadbeef',
      baseBranches: ['koala/deadbeef', 'koala/aaaaaaaa'],
    });

    expect(s).toContain('for b in koala/deadbeef koala/aaaaaaaa; do');
  });

  it('falls back to the dependency branch when the previous attempt pushed nothing', () => {
    // The loop skips a branch that is not on the remote, so a first attempt that died before
    // committing anything still starts from its dependencies rather than from nothing.
    const s = buildCheckoutScript({
      cloneUrl: 'u', cleanUrl: 'c', branch: 'koala/deadbeef', baseBranches: ['koala/aaaaaaaa'],
    });

    expect(s).toContain('git rev-parse --verify --quiet "origin/$b"');
    expect(s).toContain('continue');
  });
});

describe('landing verified work on the default branch', () => {
  const merge = () => buildMergeScript('koala/deadbeef');

  it('detects the default branch instead of assuming main', () => {
    // `main` is what the initialiser makes today, but a repository registered from elsewhere can
    // be on `master` — and pushing to the wrong name silently creates a third branch nobody looks
    // at either, which is the bug this whole thing exists to fix.
    expect(merge()).toContain('refs/remotes/origin/HEAD');
    expect(merge()).toContain('DEFAULT=main');
  });

  it('fast-forwards when it can', () => {
    // A chain already contains the default branch's history, so a merge commit would be noise.
    expect(merge()).toContain('git merge --ff-only');
  });

  it('falls back to a real merge when it cannot fast-forward', () => {
    expect(merge()).toContain('git merge --no-edit');
  });

  it('abandons a conflict rather than forcing it', () => {
    // The work is safe on its own branch. Resolving here would mean guessing at someone else's
    // changes with no way to check the result.
    const s = merge();
    expect(s).toContain('git merge --abort');
    expect(s).toContain('MERGE=conflict');
  });

  it('reports a push that was rejected separately from one that conflicted', () => {
    // Different problems: one needs a human to merge, the other needs permissions looking at.
    expect(merge()).toContain('MERGE=rejected');
  });

  it('reads the verdict back', () => {
    expect(parseMergeResult('MERGE=merged')).toBe('merged');
    expect(parseMergeResult('MERGE=conflict')).toBe('conflict');
  });

  it('treats unreadable output as "did not land"', () => {
    // Never guess that work reached main. The board would then point at a branch that has nothing.
    expect(parseMergeResult('some noise')).toBe('skipped');
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

/**
 * Checkpoints: the save point a leaf writes mid-run.
 *
 * The failure they exist for is not a crash — it is the activity's own wall-clock timeout. One
 * Temporal activity wraps the whole loop, so a run killed at 31 minutes restarted at step zero with
 * `/work` (an emptyDir) already destroyed and nothing pushed. Everything below is about making the
 * save survive that, and about not creating new failure modes while doing it.
 */
describe('where a checkpoint is written', () => {
  it('is unique per leaf, so siblings cannot conflict at landing', () => {
    /**
     * A shared PROGRESS.md is the obvious design and it is the trap: two sibling leaves branching
     * from a common base and landing through buildMergeScript would conflict on a file NEITHER
     * agent wrote, stranding real work and sending ResolveLandingActivity off to resolve harness
     * bookkeeping with a whole agent run.
     */
    expect(checkpointPath('aaaaaaaa-1111')).not.toBe(checkpointPath('bbbbbbbb-2222'));
  });

  it('is deterministic, so a retry overwrites its own save rather than adding one', () => {
    expect(checkpointPath('aaaaaaaa-1111')).toBe(checkpointPath('aaaaaaaa-1111'));
  });

  it('lives under .koala/, which the layout extractor skips', () => {
    expect(checkpointPath('abcdef12')).toMatch(/^\.koala\//);
  });
});

describe('committing and proving a checkpoint', () => {
  const script = buildCheckpointScript();

  it('interpolates nothing — branch and path arrive as argv', () => {
    // Same rule as every other script here: the values are stored data, and stored data is
    // untrusted regardless of who wrote it.
    expect(script).toContain('"$0"');
    expect(script).toContain('"$1"');
  });

  it('commits the agent’s work before the artifact that describes it', () => {
    expect(script.indexOf('work in progress')).toBeLessThan(script.indexOf('koala: checkpoint'));
  });

  it('asks the REMOTE whether the push landed', () => {
    /**
     * This is the load-bearing line. `outputBranch` is written from this result and
     * buildCheckoutScript positions the next attempt with it — so a push that silently failed
     * while this reported success would send attempt 2 branching off the default and lose
     * everything the checkpoint was meant to save.
     */
    expect(script).toContain('git ls-remote --heads origin "$0"');
  });

  it('reads back a confirmed checkpoint', () => {
    const out = parseCheckpointResult('noise\nCHECKPOINT:koala/abc12345:9f8e7d6\nmore noise');
    expect(out).toEqual({ branch: 'koala/abc12345', sha: '9f8e7d6' });
  });

  it('reports nothing when the remote did not confirm', () => {
    // Absent must mean "did not land", never "probably fine".
    expect(parseCheckpointResult('git push failed\n')).toBeUndefined();
  });
});

describe('what the repository shows at a checkpoint', () => {
  it('measures this leaf’s contribution, not the repository’s history', () => {
    const script = buildProgressScript();
    expect(script).toContain('origin/$0..HEAD');
  });

  it('survives a repo with no remote-tracking base yet', () => {
    // A first checkpoint has nothing to diff against; falling back to full history is the same
    // answer there, and failing outright would lose the save entirely.
    const script = buildProgressScript();
    expect(script).toContain('|| git log --oneline');
    expect(script).toContain('|| git diff --stat HEAD');
  });

  it('splits the two sections the artifact renders separately', () => {
    const out = parseProgress('COMMITS:\na1b2c3 add bucket\nCHANGED:\n 2 files changed, 40 insertions');
    expect(out.commits).toBe('a1b2c3 add bucket');
    expect(out.changed).toBe('2 files changed, 40 insertions');
  });

  it('returns empty strings rather than throwing on an empty repo', () => {
    expect(parseProgress('')).toEqual({ commits: '', changed: '' });
  });
});
