import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSeedBundle } from './seed-bundle.js';

const run = promisify(execFile);

describe('the files a check starts with', () => {
  it('become one commit on main in a bundle a repository can be pushed from', async () => {
    const out = await mkdtemp(join(tmpdir(), 'seed-test-'));
    try {
      await withSeedBundle({ 'notes/plan.md': '# Plan\n', 'README.md': 'hi\n' }, async (bundle) => {
        await run('git', ['clone', '-q', '-b', 'main', bundle, join(out, 'clone')]);
      });
      expect(await readFile(join(out, 'clone', 'notes/plan.md'), 'utf8')).toBe('# Plan\n');
      expect((await run('git', ['-C', join(out, 'clone'), 'log', '--oneline'])).stdout.trim().split('\n')).toHaveLength(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('refuses a path outside the workspace', async () => {
    await expect(withSeedBundle({ '/etc/passwd': 'x' }, async () => undefined)).rejects.toThrow('not a path inside the workspace');
  });
});
