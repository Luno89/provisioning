import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';

const dir = process.env.COUPLING_COVERAGE;
if (dir) {
  const { startCollecting } = await import('./collect.js');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const collector = await startCollecting({ dir, root, keep: (file) => !file.startsWith('..') && !file.includes('node_modules') && !/\.test\.tsx?$/.test(file) });
  afterAll(async () => {
    await collector.take(expect.getState().testPath ?? 'unknown');
  });
}
