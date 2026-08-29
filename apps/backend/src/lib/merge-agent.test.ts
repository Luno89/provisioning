import { describe, it, expect } from 'vitest';
import {
  buildLandingSetupScript, buildMergeOneScript, buildMergeCompleteScript, parseLandingMerge, buildMergeTask,
} from './merge-agent.js';

describe('positioning the landing branch', () => {
  it('is a separate step from merging, and only runs once', () => {
    const setup = buildLandingSetupScript('main');

    expect(setup).toContain('git checkout -B landing "origin/main"');
    expect(buildMergeOneScript('koala/aaaaaaaa')).not.toContain('checkout -B landing');
  });
});

describe('merging one branch', () => {
  it('merges into whatever is checked out', () => {
    expect(buildMergeOneScript('koala/aaaaaaaa')).toContain('git merge --no-edit "origin/koala/aaaaaaaa"');
  });

  it('leaves the conflicted tree in place rather than aborting', () => {
    const s = buildMergeOneScript('koala/aaaaaaaa');

    expect(s).not.toContain('git merge --abort');
    expect(s).toContain('git diff --name-only --diff-filter=U');
  });

  it('refuses a branch name it could not have minted', () => {
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
    const s = buildMergeCompleteScript();

    expect(s).toContain('--diff-filter=U');
    expect(s).toContain('MERGE_HEAD');
  });

  it('distinguishes resolved-but-uncommitted from still-conflicted', () => {
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
    expect(parseLandingMerge('').outcome).toBe('unknown');
  });
});

describe('what the resolving agent is told', () => {
  const task = () => buildMergeTask('koala/aaaaaaaa', ['README.md']);

  it('says neither side wins', () => {
    expect(task()).toMatch(/BOTH sides/);
    expect(task()).toMatch(/Neither side is more correct/);
  });

  it('forbids weakening the tests to get green', () => {
    expect(task()).toMatch(/do not weaken/i);
    expect(task()).toMatch(/not delete a passing test/i);
  });

  it('keeps the brief narrow', () => {
    expect(task()).toMatch(/Do not add features, refactor/);
  });

  it('tells it not to push', () => {
    expect(task()).toMatch(/Do not push/);
  });

  it('names the conflicted files when it knows them', () => {
    expect(task()).toContain('README.md');
    expect(buildMergeTask('koala/aaaaaaaa', [])).toContain('--diff-filter=U');
  });
});
