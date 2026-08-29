import { describe, it, expect, vi } from 'vitest';
import { trimDiff, buildDiffScript, captureEvidence, MAX_DIFF_CHARS } from './leaf-evidence.js';

const fileDiff = (path: string, body = 'x'.repeat(100)) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${body}`;

describe('what the diff keeps', () => {
  it('keeps the stat line even when patches are dropped', () => {
    const raw = `STAT:\n 3 files changed, 40 insertions(+)\nPATCH:\n${fileDiff('src/a.ts', 'y'.repeat(50_000))}`;
    const out = trimDiff(raw);
    expect(out.diff).toContain('3 files changed');
    expect(out.truncated).toBe(true);
  });

  it('drops lockfiles and vendored paths, not hand-written code', () => {
    const raw = [
      'STAT:', ' 2 files changed', 'PATCH:',
      fileDiff('package-lock.json', 'z'.repeat(5_000)),
      fileDiff('src/limiter.ts', 'const bucket = 1;'),
      fileDiff('node_modules/dep/index.js'),
    ].join('\n');
    const out = trimDiff(raw);

    expect(out.diff).toContain('src/limiter.ts');
    expect(out.diff).not.toContain('package-lock.json');
    expect(out.diff).not.toContain('node_modules');
  });

  it('says how much it dropped rather than eliding silently', () => {
    const raw = `STAT:\n stat\nPATCH:\n${fileDiff('package-lock.json')}`;
    expect(trimDiff(raw).diff).toMatch(/1 more changed file\(s\) not shown/);
  });

  it('stays inside its budget', () => {
    const raw = `STAT:\n stat\nPATCH:\n${Array.from({ length: 50 }, (_, i) => fileDiff(`src/f${i}.ts`, 'q'.repeat(2_000))).join('\n')}`;
    expect(trimDiff(raw).diff.length).toBeLessThan(MAX_DIFF_CHARS + 500);
  });

  it('handles a run that changed nothing', () => {
    expect(trimDiff('STAT:\nPATCH:\n').diff).toBe('');
    expect(trimDiff('').truncated).toBe(false);
  });

  it('takes the base ref as a positional rather than interpolating it', () => {
    const script = buildDiffScript();
    expect(script).toContain('$0');
    expect(buildDiffScript()).toBe(script);
  });
});

describe('capturing from a sandbox about to be destroyed', () => {
  const ws = (over: any = {}) => ({
    exec: vi.fn(async () => ({ stdout: `STAT:\n 1 file changed\nPATCH:\n${fileDiff('src/a.ts')}`, stderr: '', exitCode: 0 })),
    readFile: vi.fn(async () => 'file contents'),
    ...over,
  });

  it('gathers the diff, the declared files, and the verify output', async () => {
    const out = await captureEvidence({
      workspaces: ws(), leafId: 'l1', base: 'main',
      expects: ['src/a.ts'], verifyOutput: 'all tests passed',
    });

    expect(out.diff).toContain('src/a.ts');
    expect(out.expects?.[0]?.path).toBe('src/a.ts');
    expect(out.verifyOutput).toBe('all tests passed');
    expect(out.capturedAt).toBeTruthy();
  });

  it('skips the diff for a persona with no repository', async () => {
    const workspaces = ws();
    const out = await captureEvidence({ workspaces, leafId: 'l1', findings: '# Answer' });

    expect(workspaces.exec).not.toHaveBeenCalled();
    expect(out.findings).toBe('# Answer');
  });

  it('keeps what it can when the diff fails', async () => {
    const out = await captureEvidence({
      workspaces: ws({ exec: vi.fn(async () => { throw new Error('sandbox gone'); }) }),
      leafId: 'l1', base: 'main', expects: ['src/a.ts'],
    });

    expect(out.diff).toBeUndefined();
    expect(out.expects).toHaveLength(1);
  });

  it('never throws, whatever the sandbox does', async () => {
    const dead = {
      exec: vi.fn(async () => { throw new Error('gone'); }),
      readFile: vi.fn(async () => { throw new Error('gone'); }),
    };
    await expect(captureEvidence({ workspaces: dead, leafId: 'l1', base: 'main', expects: ['a'] }))
      .resolves.toMatchObject({ capturedAt: expect.any(String) });
  });
});
