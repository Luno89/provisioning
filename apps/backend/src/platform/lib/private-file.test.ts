import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writePrivate } from './private-file.js';

describe('a file only its owner reads', () => {
  it('is written readable by its owner alone, even over one that was readable by everyone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'private-file-'));
    try {
      const path = join(dir, 'kubeconfig');
      writeFileSync(path, 'old', { mode: 0o644 });
      await writePrivate(path, 'apiVersion: v1');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('apiVersion: v1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
