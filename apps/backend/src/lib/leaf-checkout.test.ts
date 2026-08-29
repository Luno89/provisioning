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
    const a = leaf({ id: 'a' });
    const b = leaf({ id: 'b', outputBranch: 'koala/bbbbbbbb' });

    expect(baseBranchesFor({ dependsOn: ['a', 'b'] }, [a, b])).toEqual(['koala/bbbbbbbb']);
  });

  it('returns nothing when the leaf depends on nothing', () => {
    expect(baseBranchesFor({}, [])).toEqual([]);
  });

  it('drops a branch name it could not have minted', () => {
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
    const s = script(['koala/aaaaaaaa']);

    expect(s).toContain('git checkout -B "$1" "origin/$b"');
    expect(s).toContain('for b in koala/aaaaaaaa; do');
  });

  it('fetches every branch, because a clone does not include them', () => {
    expect(script(['koala/aaaaaaaa'])).toContain('git fetch');
  });

  it('falls back to the default branch when no dependency pushed', () => {
    const s = script([]);

    expect(s).toContain('if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi');
    expect(s).not.toContain('for b in');
  });

  it('still cuts a branch when every named base is missing', () => {
    const s = script(['koala/aaaaaaaa']);
    expect(s).toContain('STARTED=0');
    expect(s).toContain('if [ "$STARTED" = "0" ]; then git checkout -b "$1"; fi');
  });

  it('merges a second dependency rather than ignoring it', () => {
    const s = script(['koala/aaaaaaaa', 'koala/bbbbbbbb']);
    expect(s).toContain('git merge --no-edit "origin/$b"');
  });

  it('abandons a conflicted merge instead of leaving the index half-applied', () => {
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
    const s = script([]);
    expect(s).not.toContain('gitea/r.git');
    expect(s).not.toContain('koala/deadbeef');
  });
});

describe('resuming a failed attempt', () => {
  it('starts from this leaf\'s own branch before its dependencies', () => {
    const s = buildCheckoutScript({
      cloneUrl: 'u', cleanUrl: 'c', branch: 'koala/deadbeef',
      baseBranches: ['koala/deadbeef', 'koala/aaaaaaaa'],
    });

    expect(s).toContain('for b in koala/deadbeef koala/aaaaaaaa; do');
  });

  it('falls back to the dependency branch when the previous attempt pushed nothing', () => {
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
    expect(merge()).toContain('refs/remotes/origin/HEAD');
    expect(merge()).toContain('DEFAULT=main');
  });

  it('fast-forwards when it can', () => {
    expect(merge()).toContain('git merge --ff-only');
  });

  it('falls back to a real merge when it cannot fast-forward', () => {
    expect(merge()).toContain('git merge --no-edit');
  });

  it('abandons a conflict rather than forcing it', () => {
    const s = merge();
    expect(s).toContain('git merge --abort');
    expect(s).toContain('MERGE=conflict');
  });

  it('reports a push that was rejected separately from one that conflicted', () => {
    expect(merge()).toContain('MERGE=rejected');
  });

  it('reads the verdict back', () => {
    expect(parseMergeResult('MERGE=merged')).toBe('merged');
    expect(parseMergeResult('MERGE=conflict')).toBe('conflict');
  });

  it('treats unreadable output as "did not land"', () => {
    expect(parseMergeResult('some noise')).toBe('skipped');
  });
});

describe('the push-back script', () => {
  it('commits and pushes work the agent left behind', () => {
    const s = buildPushScript('koala/deadbeef');
    expect(s).toContain('git commit');
    expect(s).toContain('git push -u origin HEAD');
  });

  it('reports the branch only when the remote confirms it', () => {
    expect(buildPushScript('koala/deadbeef')).toContain('git ls-remote --heads origin');
  });

  it('reads the branch back out of the output', () => {
    expect(parsePushedBranch('some noise\nPUSHED:koala/deadbeef\n')).toBe('koala/deadbeef');
  });

  it('reports nothing when the push never landed', () => {
    expect(parsePushedBranch('fatal: could not read Username\n')).toBeUndefined();
  });
});

describe('where a checkpoint is written', () => {
  it('is unique per leaf, so siblings cannot conflict at landing', () => {
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
    expect(script).toContain('"$0"');
    expect(script).toContain('"$1"');
  });

  it('commits the agent’s work before the artifact that describes it', () => {
    expect(script.indexOf('work in progress')).toBeLessThan(script.indexOf('koala: checkpoint'));
  });

  it('asks the REMOTE whether the push landed', () => {
    expect(script).toContain('git ls-remote --heads origin "$0"');
  });

  it('reads back a confirmed checkpoint', () => {
    const out = parseCheckpointResult('noise\nCHECKPOINT:koala/abc12345:9f8e7d6\nmore noise');
    expect(out).toEqual({ branch: 'koala/abc12345', sha: '9f8e7d6' });
  });

  it('reports nothing when the remote did not confirm', () => {
    expect(parseCheckpointResult('git push failed\n')).toBeUndefined();
  });
});

describe('what the repository shows at a checkpoint', () => {
  it('measures this leaf’s contribution, not the repository’s history', () => {
    const script = buildProgressScript();
    expect(script).toContain('origin/$0..HEAD');
  });

  it('survives a repo with no remote-tracking base yet', () => {
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
