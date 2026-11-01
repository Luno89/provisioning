import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, inject } from 'vitest';
import { closeTestDatabases } from './src/platform/lib/test-database.js';

process.env.MONGO_URI = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

afterAll(async () => {
  await closeTestDatabases();
});

const couplingDir = process.env.COUPLING_COVERAGE;
if (couplingDir) {
  const { startCollecting } = await import('../../tests/coupling/collect.js');
  const collector = await startCollecting({ dir: couplingDir, root: dirname(fileURLToPath(import.meta.url)), keep: (file) => !file.includes('node_modules') && !/\.test\.tsx?$/.test(file) });
  afterAll(async () => {
    await collector.take(expect.getState().testPath ?? 'unknown');
  });
}
