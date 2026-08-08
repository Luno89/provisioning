/**
 * Both directions of this were observed on real runs, which is why it is a module and not a
 * conditional buried in the activity.
 *
 *   · A leaf reported creating a file, accurately, and was marked succeeded — nothing had been
 *     committed and the pod was seconds from being destroyed.
 *   · A leaf capped at 7 steps failed all three attempts while its branch accumulated all nine
 *     expected files and nine passing tests. It was marked failed. The work was done.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultVerifyCommand, buildVerifyScript, parseVerifyResult, decideStatus,
} from './leaf-verify.js';

describe('what gets run', () => {
  it('runs the node test files, never the bare directory', () => {
    /**
     * `node --test test/` resolves `test/` as a MODULE on current Node, fails with
     * MODULE_NOT_FOUND, and reports one failing test — which reads as a real failure of the work.
     * It produced a false report against correct code twice in one session.
     */
    expect(defaultVerifyCommand('node')).toContain('node --test');
    expect(defaultVerifyCommand('node')).not.toContain('--test test/ ');
  });

  it('finds tests at the root as well as under test/', () => {
    // Caught while backfilling: two repositories with green suites scored as unverified purely
    // because their test files sat beside the source instead of in a directory.
    const cmd = defaultVerifyCommand('node')!;
    expect(cmd).toContain('test/*.test.js');
    expect(cmd).toContain('*.test.js');
    // Separate invocations for the same reason as the guard: one empty pattern must not suppress
    // the other's output.
    expect(cmd).toContain(';');
  });

  it('has a command per toolchain, and none for the bare image', () => {
    expect(defaultVerifyCommand('python')).toContain('pytest');
    expect(defaultVerifyCommand('go')).toContain('go test');
    // Nothing installed to run anything with — claiming a verdict would be a lie.
    expect(defaultVerifyCommand('base')).toBeUndefined();
  });

  it('defaults to node when the leaf never said', () => {
    expect(defaultVerifyCommand(undefined)).toBe(defaultVerifyCommand('node'));
  });
});

describe('the verify script', () => {
  it('reports the exit code through stdout', () => {
    // A pipe to tail would otherwise swallow it, and the exit status is the whole verdict.
    expect(buildVerifyScript('npm test', 'node')).toContain('KOALA_VERIFY_EXIT');
  });

  it('bails out as unverified when there is no suite to run', () => {
    // Without the guard the glob passes through literally and node reports a missing file as a
    // failing test — a leaf that simply is not test-shaped would be marked broken.
    const s = buildVerifyScript('node --test test/*.test.js', 'node');

    expect(s).toContain('=127');
  });

  it('tests each layout separately, because ls fails on a missing operand', () => {
    /**
     * `ls a b` exits non-zero when EITHER operand is missing, even when the other matched. A single
     * `ls test/*.test.js *.test.js` therefore reported "no suite" for every repository keeping its
     * tests in test/ — caught live, two leaves with green suites came back unverified and fell
     * through to trusting the agent's claim.
     */
    const s = buildVerifyScript('x', 'node');

    expect(s).toContain('ls test/*.test.js >/dev/null 2>&1 || ls *.test.js >/dev/null 2>&1');
    expect(s).not.toContain('ls test/*.test.js *.test.js');
  });

  it('runs inside the repository', () => {
    expect(buildVerifyScript('npm test', 'node')).toContain('cd /work/repo');
  });

  it('keeps the output whether it passed or failed', () => {
    // A failing suite's output is the most useful thing the next attempt could be handed.
    expect(buildVerifyScript('npm test', 'node')).toContain('2>&1 | tail');
  });
});

describe('reading the result', () => {
  it('passes on exit 0', () => {
    expect(parseVerifyResult('# pass 9\nKOALA_VERIFY_EXIT=0').outcome).toBe('passed');
  });

  it('fails on a non-zero exit', () => {
    const r = parseVerifyResult('AssertionError: 3 !== 4\nKOALA_VERIFY_EXIT=1');

    expect(r.outcome).toBe('failed');
    // The failure text is what the retry gets to act on.
    expect(r.output).toContain('AssertionError');
  });

  it('treats "nothing to run" as unverified, not as failure', () => {
    // Most leaves are not test-shaped. Calling them all failures would make the signal useless.
    expect(parseVerifyResult('KOALA_VERIFY_EXIT=127').outcome).toBe('unverified');
  });

  it('treats a script that never finished as unverified', () => {
    // A workspace that died, or a command that hung. Not a judgement about the work.
    expect(parseVerifyResult('some half output').outcome).toBe('unverified');
  });

  it('strips the sentinel out of the reported output', () => {
    expect(parseVerifyResult('all good\nKOALA_VERIFY_EXIT=0').output).toBe('all good');
  });
});

describe('who wins: the agent or the repository', () => {
  it('overrides a success claim that the suite contradicts', () => {
    // The claim is a claim. The exit code is a result.
    expect(decideStatus(true, 'failed')).toBe('failed');
  });

  it('rescues work that passes despite the agent never finishing', () => {
    // The 7-step run: three failed attempts, nine files, nine passing tests, marked failed.
    expect(decideStatus(false, 'passed')).toBe('succeeded');
  });

  it('falls back to the claim when nothing could be checked', () => {
    expect(decideStatus(true, 'unverified')).toBe('succeeded');
    expect(decideStatus(false, 'unverified')).toBe('failed');
  });
});
