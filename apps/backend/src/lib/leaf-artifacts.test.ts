/**
 * Verification ran the work's own test suite, which covers code and nothing else. A research leaf
 * has no suite, so it came back unverified and the agent's claim was believed — leaving the
 * original failure live for exactly the work that cannot be tested.
 */
import { describe, it, expect } from 'vitest';
import {
  usablePaths, buildArtifactCheckScript, parseArtifactResult, combineVerification,
} from './leaf-artifacts.js';

describe('which paths are acted on', () => {
  it('accepts ordinary repository paths', () => {
    expect(usablePaths(['NOTES.md', 'docs/findings.md', 'src/a-b_c.js']))
      .toEqual(['NOTES.md', 'docs/findings.md', 'src/a-b_c.js']);
  });

  it('drops anything that could escape the repository', () => {
    // Paths come from model output and are interpolated into a shell script.
    expect(usablePaths(['../../etc/passwd', '/etc/passwd', 'a/../../b'])).toEqual([]);
  });

  it('drops shell metacharacters rather than escaping them', () => {
    // A "cleaned" version would check something nobody asked for.
    expect(usablePaths(['NOTES.md; rm -rf /', '$(whoami)', 'a`b`'])).toEqual([]);
  });

  it('drops an absurdly long path', () => {
    expect(usablePaths([`${'a'.repeat(300)}.md`])).toEqual([]);
  });
});

describe('the check itself', () => {
  it('requires the file to be TRACKED, not merely present', () => {
    /**
     * An untracked file sits in a container about to be deleted, which is the precise failure being
     * guarded against — a leaf reported creating a file, accurately, having committed nothing.
     */
    expect(buildArtifactCheckScript(['NOTES.md'])).toContain('git ls-files -- "NOTES.md"');
  });

  it('requires the file to be non-empty', () => {
    // A file created and never written to is not the artifact anybody asked for.
    expect(buildArtifactCheckScript(['NOTES.md'])).toContain('[ ! -s "NOTES.md" ]');
  });

  it('requires the file to have CHANGED, not merely to exist', () => {
    /**
     * The hole the first version left. A leaf asked to rewrite src/cli.js could declare it, never
     * touch it, and pass — the three-line stub a previous leaf committed is tracked and non-empty
     * and satisfies every other question. Observed end to end: a five-leaf plan delivered a CLI
     * that printed its own name and exited, with every leaf green.
     */
    const s = buildArtifactCheckScript(['src/cli.js'], 'main');

    expect(s).toContain('git diff --quiet "$BASE" -- "src/cli.js"');
    // Recorded as STALE rather than missing now — see combineVerification for why an untouched but
    // present file is not the same failure as one that does not exist.
    expect(s).toContain('STALE="$STALE src/cli.js"');
  });

  it('diffs against the default branch, not the previous attempt', () => {
    // A retry inherits its own earlier commits, so diffing against where THIS attempt started would
    // fail a leaf for work its first attempt already did.
    expect(buildArtifactCheckScript(['a.md'], 'trunk')).toContain('origin/trunk');
  });

  it('skips the change check when there is no default branch yet', () => {
    // A repository with no base: every file is new by definition, and failing everything would be
    // wrong rather than strict.
    expect(buildArtifactCheckScript(['a.md'])).toContain('BASE=""');
  });

  it('refuses a default branch name it could not have come from', () => {
    expect(buildArtifactCheckScript(['a.md'], 'main; rm -rf /')).not.toContain('rm -rf');
  });

  it('reports an unchanged file as missing', () => {
    expect(parseArtifactResult('KOALA_ARTIFACTS=missing src/cli.js(unchanged)').missing)
      .toEqual(['src/cli.js(unchanged)']);
  });

  it('says which paths were missing, and why', () => {
    const r = parseArtifactResult('KOALA_ARTIFACTS=missing NOTES.md(uncommitted) docs/x.md(empty)');

    expect(r.outcome).toBe('missing');
    expect(r.missing).toEqual(['NOTES.md(uncommitted)', 'docs/x.md(empty)']);
  });

  it('reports "none" when the leaf declared nothing', () => {
    // Not a pass and not a failure — most leaves declare no artifacts and must stay judgeable by
    // their tests alone.
    expect(parseArtifactResult(buildArtifactCheckScript([])).outcome).toBe('none');
  });

  it('treats a script that never ran as unknown', () => {
    expect(parseArtifactResult('').outcome).toBe('unknown');
  });

  it('passes when everything is there', () => {
    expect(parseArtifactResult('KOALA_ARTIFACTS=present').outcome).toBe('present');
  });
});

describe('combining the two checks', () => {
  it('fails when a promised file is absent, even with a green suite', () => {
    // The leaf did part of its job. This is the research-leaf case in miniature.
    expect(combineVerification('passed', 'missing')).toBe('failed');
  });

  it('fails on a red suite, even with every artifact present', () => {
    expect(combineVerification('failed', 'present')).toBe('failed');
  });

  it('verifies a research leaf on its artifacts alone', () => {
    // No suite to run. Demanding both would make this permanently unverifiable.
    expect(combineVerification('unverified', 'present')).toBe('passed');
  });

  it('verifies a code leaf on its tests alone', () => {
    expect(combineVerification('passed', 'none')).toBe('passed');
  });

  it('stays unverified when neither check could say anything', () => {
    // Falls back to the agent's claim, and records that nothing checked it.
    expect(combineVerification('unverified', 'none')).toBe('unverified');
    expect(combineVerification('unverified', 'unknown')).toBe('unverified');
  });
});

describe('the two ways this check failed correct work', () => {
  it('finds a declared file that was written somewhere else', () => {
    /**
     * Measured. The planner asked for `src/util/version.test.js` while decomposing, before anyone
     * had seen the repository. The agent read the repo, saw that tests live in `test/`, wrote
     * `test/version.test.js`, ran it, committed and pushed — and the leaf was failed for the
     * directory.
     *
     * The planner names these paths from a guess; the agent names them from the repository.
     */
    const s = buildArtifactCheckScript(['src/util/version.test.js'], 'main');
    expect(s).toContain('git ls-files -- "*/version.test.js"');
    expect(s).toContain('MOVED=');
  });

  it('only accepts a moved file this leaf actually changed', () => {
    // Otherwise "some file with this name exists somewhere in the repo" would satisfy a promise,
    // which is the opposite of what this check is for.
    const s = buildArtifactCheckScript(['src/util/version.test.js'], 'main');
    expect(s).toContain('! git diff --quiet "$BASE" -- "$CAND"');
    expect(s).toContain('[ -s "$CAND" ]');
  });

  it('reports a moved file rather than passing silently', () => {
    const r = parseArtifactResult('KOALA_ARTIFACTS_MOVED= src/util/version.test.js->test/version.test.js\nKOALA_ARTIFACTS=present');
    expect(r.outcome).toBe('present');
    expect(r.moved).toEqual(['src/util/version.test.js->test/version.test.js']);
  });

  it('does not fail a leaf whose deliverable a sibling already produced', () => {
    /**
     * The other measured failure. A leaf asked to add tests found them already written and
     * committed by the leaf that built the module, confirmed 30 of them passed, and had nothing
     * to commit — so it was failed, and the retry it triggered could never succeed because there
     * was nothing left to create.
     */
    expect(combineVerification('unverified', 'stale')).toBe('unverified');
    expect(combineVerification('passed', 'stale')).toBe('passed');
  });

  it('still fails a leaf that promised a file and produced none', () => {
    // The guarantee that must survive both fixes.
    expect(combineVerification('unverified', 'missing')).toBe('failed');
    expect(combineVerification('passed', 'missing')).toBe('failed');
  });

  it('reads a stale verdict back with what was untouched', () => {
    const r = parseArtifactResult('KOALA_ARTIFACTS=stale src/cli.js');
    expect(r).toMatchObject({ outcome: 'stale', missing: ['src/cli.js'] });
  });

  it('lets missing beat stale when both happen', () => {
    // Something that does not exist anywhere is the real failure; a present-but-untouched file
    // must not hide it.
    const s = buildArtifactCheckScript(['a.js', 'b.js'], 'main');
    expect(s.indexOf('=missing')).toBeLessThan(s.indexOf('=stale'));
  });
});
