import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ROOT } from './artifacts.js';
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
    const records = readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Ran);
    expect(records.map((record) => record.testFile)).toEqual(['tests/coupling/collect.integration.test.ts', 'tests/coupling/collect.integration.test.ts']);
    const queueOfIn = (record: Ran | undefined) => record?.files['apps/backend/src/platform/lib/work-places.ts']?.find((range) => range.fn !== undefined && range.start.line === 12)?.count;
    const child = records.find((record) => queueOfIn(record) === 1);
    const places = child?.files['apps/backend/src/platform/lib/work-places.ts'] ?? [];
    const queueOf = places.find((range) => range.fn !== undefined && range.start.line === 12);
    expect(queueOf?.count).toBe(1);
    expect(places.find((range) => range.fn !== undefined && range.start.line === 20)?.count ?? 0).toBe(0);
  }, 120_000);
});
