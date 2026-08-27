/**
 * Verification ran the work's own test suite, which covers code and nothing else. A research leaf
 * has no suite, so it came back unverified and the agent's claim was believed — leaving the
 * original failure live for exactly the work that cannot be tested.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  usablePaths, buildArtifactCheckScript, parseArtifactResult, combineVerification,
} from './leaf-artifacts.js';
import { conventionsOf } from './tree-type-conventions.js';
import type { TreeTypeSpec } from './tree-types.js';

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

/**
 * ── THE REAL CASE, EXECUTED ──
 *
 * Every test above asserts on the TEXT of the generated script, which cannot show whether the shell
 * actually finds the file. This block builds a real git repository and runs the script against it.
 *
 * It reproduces the failure that cost a whole tree: on a `language: 'node'` type whose scaffold is
 * plain JavaScript, the planner declared `expects: ['src/tools.ts']`. The agent wrote, committed and
 * pushed `src/tools.js`, all 34 tests passed, and the leaf was failed three times because the
 * checker looked for a `.ts` file that a JavaScript project was never going to have.
 *
 * The script's first line is `cd /work/repo || cd /work || exit 0`, which only resolves inside a
 * workspace pod, so it is dropped here and the script is run in the temp repo instead. Everything
 * below that line — the git plumbing this is actually testing — runs verbatim.
 */
describe('executed against a real repository', () => {
  const runScript = (script: string, cwd: string): string => {
    const withoutCd = script.split('\n').slice(1).join('\n');
    return execFileSync('bash', ['-c', withoutCd], { cwd, encoding: 'utf8' });
  };

  /** A repo with a committed default branch, then a leaf branch that adds `added`. */
  const makeRepo = (base: Record<string, string>, added: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'artifacts-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    const write = (files: Record<string, string>) => {
      for (const [p, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), content);
      }
    };
    write(base);
    git('add', '-A');
    git('commit', '-qm', 'base');
    // The check diffs against origin/main, so give it one that does not include the leaf's work.
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    if (Object.keys(added).length > 0) {
      write(added);
      git('add', '-A');
      git('commit', '-qm', 'leaf work');
    }
    return dir;
  };

  const nodeConventions = conventionsOf({
    id: 'api-service', ownerId: 'u1', label: 'l', summary: 's',
    language: 'node', produces: 'service', doneMeans: 'd',
    files: [{ path: 'src/server.js', content: '' }, { path: 'test/server.test.js', content: '' }],
  } as TreeTypeSpec);

  it('fails a .ts expectation in a .js project when given no conventions — the bug', () => {
    const dir = makeRepo({ 'README.md': 'x' }, { 'src/tools.js': 'export const a = 1;\n' });
    const out = runScript(buildArtifactCheckScript(['src/tools.ts'], 'main'), dir);
    const result = parseArtifactResult(out);
    expect(result.outcome).toBe('missing');
    // …and a missing artifact hard-fails the leaf even though its suite is green.
    expect(combineVerification('passed', result.outcome)).toBe('failed');
  });

  it('finds the sibling extension when the template says the project is JavaScript', () => {
    const dir = makeRepo({ 'README.md': 'x' }, { 'src/tools.js': 'export const a = 1;\n' });
    const out = runScript(buildArtifactCheckScript(['src/tools.ts'], 'main', nodeConventions), dir);
    const result = parseArtifactResult(out);
    expect(result.outcome).toBe('present');
    expect(result.moved.join(' ')).toContain('src/tools.js');
    expect(combineVerification('passed', result.outcome)).toBe('passed');
  });

  it('still finds a file the agent moved to another directory', () => {
    // The case the basename fallback was originally added for; it must keep working.
    const dir = makeRepo({ 'README.md': 'x' }, { 'test/version.test.js': 'ok\n' });
    const out = runScript(
      buildArtifactCheckScript(['src/util/version.test.js'], 'main', nodeConventions), dir);
    expect(parseArtifactResult(out).outcome).toBe('present');
  });

  it('still reports genuinely absent work as missing', () => {
    // The failure this check exists for must survive the fix.
    const dir = makeRepo({ 'README.md': 'x' }, { 'src/other.js': 'x\n' });
    const out = runScript(buildArtifactCheckScript(['src/tools.ts'], 'main', nodeConventions), dir);
    expect(parseArtifactResult(out).outcome).toBe('missing');
  });

  it('does not accept an empty file as the artifact', () => {
    const dir = makeRepo({ 'README.md': 'x' }, { 'src/tools.js': '' });
    const out = runScript(buildArtifactCheckScript(['src/tools.ts'], 'main', nodeConventions), dir);
    expect(parseArtifactResult(out).outcome).toBe('missing');
  });

  it('does not rewrite a markdown expectation into source', () => {
    const dir = makeRepo({ 'README.md': 'x' }, { 'NOTES.js': 'not the notes\n' });
    const out = runScript(buildArtifactCheckScript(['NOTES.md'], 'main', nodeConventions), dir);
    expect(parseArtifactResult(out).outcome).toBe('missing');
  });
});
