import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT, runsIn } from './artifacts.js';
import { startCollecting, type Ran } from './collect.js';

const dir = mkdtempSync(join(tmpdir(), 'koala-collect-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('what a test runs, gathered', () => {
  it('includes what the programs the test starts ran, mapped back to the production source they ran', async () => {
    const children = join(dir, 'children');
    const collector = await startCollecting({ dir, root: ROOT, keep: (file) => !file.startsWith('..') && !file.includes('node_modules'), children });
    const tsx = join(ROOT, 'node_modules', '.bin', 'tsx');
    const said = execFileSync(tsx, ['-e', `import(${JSON.stringify(join(ROOT, 'apps/backend/src/platform/lib/work-places.ts'))}).then((m) => console.log(m.queueOf('host')))`], {
      encoding: 'utf8', env: { ...process.env, ...collector.childEnv },
    });
    expect(said.trim()).toBe('host-ops-queue');
    await collector.take(join(ROOT, 'tests/coupling/collect.integration.test.ts'));
    const records = runsIn(dir);
    expect(records.map((record) => record.testFile)).toEqual(['tests/coupling/collect.integration.test.ts', 'tests/coupling/collect.integration.test.ts']);
    const queueOfIn = (record: Ran | undefined) => record?.files['apps/backend/src/platform/lib/work-places.ts']?.find((range) => range.fn !== undefined && range.start.line === 12)?.count;
    const child = records.find((record) => queueOfIn(record) === 1);
    const places = child?.files['apps/backend/src/platform/lib/work-places.ts'] ?? [];
    const queueOf = places.find((range) => range.fn !== undefined && range.start.line === 12);
    expect(queueOf?.count).toBe(1);
    expect(places.find((range) => range.fn !== undefined && range.start.line === 20)?.count ?? 0).toBe(0);
  });

  it('keeps what ran before each part was taken, so a test file whose coverage is too large to take at once is still one record', async () => {
    const parts = mkdtempSync(join(tmpdir(), 'koala-collect-parts-'));
    try {
      const collector = await startCollecting({ dir: parts, root: ROOT, keep: (file) => file === 'apps/backend/src/platform/lib/work-places.ts' });
      const places = await import('../../apps/backend/src/platform/lib/work-places.js');
      expect(places.queueOf('host')).toBe('host-ops-queue');
      await collector.part();
      expect(places.placesOf('root')).toEqual(['host']);
      await collector.take(join(ROOT, 'tests/coupling/collect-parts.integration.test.ts'));
      const records = runsIn(parts);
      expect(records.map((record) => record.testFile)).toEqual(['tests/coupling/collect-parts.integration.test.ts']);
      const ranges = records[0]?.files['apps/backend/src/platform/lib/work-places.ts'] ?? [];
      const ranOn = (line: number): boolean => ranges.some((range) => range.fn !== undefined && range.start.line === line && range.count > 0);
      expect([ranOn(12), ranOn(19)]).toEqual([true, true]);
    } finally {
      rmSync(parts, { recursive: true, force: true });
    }
  });
});
