import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect } from 'vitest';

const dir = process.env.COUPLING_COVERAGE;
if (dir) {
  const { startCollecting } = await import('./collect.js');
  const { writePrelude } = await import('./shell-trace.js');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const shellTrace = join(dir, `shell-${process.pid}-${randomUUID()}.trace`);
  process.env.COUPLING_SHELL_TRACE = shellTrace;
  process.env.COUPLING_SHELL_PRELUDE = writePrelude(dir);
  const collector = await startCollecting({ dir, root, shellTrace, keep: (file) => !file.startsWith('..') && !file.includes('node_modules') && !/\.test\.tsx?$/.test(file) });
  afterAll(async () => {
    await collector.take(expect.getState().testPath ?? 'unknown');
  });
}
