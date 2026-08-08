/**
 * A conflict used to end in a pull request, a log line and a leaf marked
 * `verified: true, merged: false` — finished, checked work stranded on a manual step. This is the
 * agent doing what it already does inside a leaf, one level up.
 */
import { describe, it, expect } from 'vitest';
import {
  buildLandingSetupScript, buildMergeOneScript, buildMergeCompleteScript, parseLandingMerge, buildMergeTask,
} from './merge-agent.js';

describe('positioning the landing branch', () => {
  it('is a separate step from merging, and only runs once', () => {
    /**
     * Not tidiness — the correctness of the whole loop. One script that reset the branch and
     * re-merged on every round discarded the resolution the agent had just committed and handed it
     * the identical conflict again. Observed live: three rounds, three identical README.md
     * conflicts, three agent runs, no progress.
     */
    const setup = buildLandingSetupScript('main');

    expect(setup).toContain('git checkout -B landing "origin/main"');
    // The per-branch merge must never reposition.
    expect(buildMergeOneScript('koala/aaaaaaaa')).not.toContain('checkout -B landing');
  });
});

describe('merging one branch', () => {
  it('merges into whatever is checked out', () => {
    expect(buildMergeOneScript('koala/aaaaaaaa')).toContain('git merge --no-edit "origin/koala/aaaaaaaa"');
  });

  it('leaves the conflicted tree in place rather than aborting', () => {
    // The conflicted worktree is what the agent needs to look at. Aborting would hand it a clean
    // tree and a description of a problem it cannot see.
    const s = buildMergeOneScript('koala/aaaaaaaa');

    expect(s).not.toContain('git merge --abort');
    expect(s).toContain('git diff --name-only --diff-filter=U');
  });

  it('refuses a branch name it could not have minted', () => {
    // Branch names come from stored records and are interpolated into a shell script.
    const s = buildMergeOneScript('koala/aaaaaaaa; rm -rf /');

    expect(s).not.toContain('rm -rf');
    expect(parseLandingMerge(s).outcome).toBe('skipped');
  });

  it('skips a branch that is not on the remote', () => {
    expect(buildMergeOneScript('koala/aaaaaaaa')).toContain('git rev-parse --verify --quiet');
  });
});

describe('checking the agent actually finished', () => {
  it('asks git, not the agent', () => {
    // A run reporting success with markers still in the tree would otherwise be pushed.
    const s = buildMergeCompleteScript();

    expect(s).toContain('--diff-filter=U');
    expect(s).toContain('MERGE_HEAD');
  });

  it('distinguishes resolved-but-uncommitted from still-conflicted', () => {
    // Different problems: one needs a commit, the other needs more resolving.
    expect(parseLandingMerge('KOALA_MERGE=uncommitted').outcome).toBe('uncommitted');
    expect(parseLandingMerge('KOALA_MERGE=clean').outcome).toBe('clean');
  });
});

describe('reading the merge result', () => {
  it('recognises a clean run', () => {
    expect(parseLandingMerge('KOALA_MERGE=clean').outcome).toBe('clean');
  });

  it('picks out the branch and the conflicted files', () => {
    const r = parseLandingMerge('KOALA_MERGE=conflict branch=koala/aaaaaaaa\nREADME.md\nsrc/index.js\n');

    expect(r.outcome).toBe('conflict');
    expect(r.branch).toBe('koala/aaaaaaaa');
    expect(r.files).toEqual(['README.md', 'src/index.js']);
  });

  it('does not mistake stray output for a filename', () => {
    const r = parseLandingMerge('KOALA_MERGE=conflict branch=koala/aaaaaaaa\nREADME.md\nAuto-merging src/x.js\n');
    expect(r.files).toEqual(['README.md']);
  });

  it('reports unknown when the script produced no verdict', () => {
    // A workspace that died mid-merge. Not something to treat as either outcome.
    expect(parseLandingMerge('').outcome).toBe('unknown');
  });
});

describe('what the resolving agent is told', () => {
  const task = () => buildMergeTask('koala/aaaaaaaa', ['README.md']);

  it('says neither side wins', () => {
    // Both were verified independently. Picking a winner is what a mechanical merge already
    // refused to do, and the reason this step exists.
    expect(task()).toMatch(/BOTH sides/);
    expect(task()).toMatch(/Neither side is more correct/);
  });

  it('forbids weakening the tests to get green', () => {
    // The obvious cheat, and it would land silently on the default branch.
    expect(task()).toMatch(/do not weaken/i);
    expect(task()).toMatch(/not delete a passing test/i);
  });

  it('keeps the brief narrow', () => {
    // Widening it is how a merge becomes a rewrite of code that was already checked.
    expect(task()).toMatch(/Do not add features, refactor/);
  });

  it('tells it not to push', () => {
    // Pushing is gated on verification, which happens after this agent stops.
    expect(task()).toMatch(/Do not push/);
  });

  it('names the conflicted files when it knows them', () => {
    expect(task()).toContain('README.md');
    // And copes when it does not.
    expect(buildMergeTask('koala/aaaaaaaa', [])).toContain('--diff-filter=U');
  });
});
