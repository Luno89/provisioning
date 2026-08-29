import { describe, it, expect } from 'vitest';
import {
  defaultVerifyCommand, buildVerifyScript, parseVerifyResult, decideStatus,
} from './leaf-verify.js';

describe('what gets run', () => {
  it('runs the node test files, never the bare directory', () => {
    expect(defaultVerifyCommand('node')).toContain('node --test');
    expect(defaultVerifyCommand('node')).not.toContain('--test test/ ');
  });

  it('finds tests at the root as well as under test/', () => {
    const cmd = defaultVerifyCommand('node')!;
    expect(cmd).toContain('test/*.test.js');
    expect(cmd).toContain('*.test.js');
    expect(cmd).toContain(';');
  });

  it('has a command per toolchain, and none for the bare image', () => {
    expect(defaultVerifyCommand('python')).toContain('unittest');
    expect(defaultVerifyCommand('go')).toContain('go test');
    expect(defaultVerifyCommand('base')).toBeUndefined();
  });

  it('defaults to node when the leaf never said', () => {
    expect(defaultVerifyCommand(undefined)).toBe(defaultVerifyCommand('node'));
  });
});

describe('the verify script', () => {
  it('reports the exit code through stdout', () => {
    expect(buildVerifyScript('npm test', 'node')).toContain('KOALA_VERIFY_EXIT');
  });

  it('bails out as unverified when there is no suite to run', () => {
    const s = buildVerifyScript('node --test test/*.test.js', 'node');

    expect(s).toContain('=127');
  });

  it('tests each layout separately, because ls fails on a missing operand', () => {
    const s = buildVerifyScript('x', 'node');

    expect(s).toContain('ls test/*.test.js >/dev/null 2>&1 || ls *.test.js >/dev/null 2>&1');
    expect(s).not.toContain('ls test/*.test.js *.test.js');
  });

  it('runs inside the repository', () => {
    expect(buildVerifyScript('npm test', 'node')).toContain('cd /work/repo');
  });

  it('keeps the output whether it passed or failed', () => {
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
    expect(r.output).toContain('AssertionError');
  });

  it('treats "nothing to run" as unverified, not as failure', () => {
    expect(parseVerifyResult('KOALA_VERIFY_EXIT=127').outcome).toBe('unverified');
  });

  it('treats a script that never finished as unverified', () => {
    expect(parseVerifyResult('some half output').outcome).toBe('unverified');
  });

  it('strips the sentinel out of the reported output', () => {
    expect(parseVerifyResult('all good\nKOALA_VERIFY_EXIT=0').output).toBe('all good');
  });
});

describe('who wins: the agent or the repository', () => {
  it('overrides a success claim that the suite contradicts', () => {
    expect(decideStatus(true, 'failed')).toBe('failed');
  });

  it('rescues work that passes despite the agent never finishing', () => {
    expect(decideStatus(false, 'passed')).toBe('succeeded');
  });

  it('falls back to the claim when nothing could be checked', () => {
    expect(decideStatus(true, 'unverified')).toBe('succeeded');
    expect(decideStatus(false, 'unverified')).toBe('failed');
  });
});

describe('a default verify command runs with nothing installed', () => {
  it('uses the standard library runner for python', () => {
    const cmd = defaultVerifyCommand('python')!;
    expect(cmd).toContain('unittest');
    expect(cmd).not.toContain('pytest');
  });

  it('keeps node and go on their built-in runners', () => {
    expect(defaultVerifyCommand('node')).toContain('node --test');
    expect(defaultVerifyCommand('go')).toContain('go test');
  });
});
