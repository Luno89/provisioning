import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const world = mkdtempSync(join(tmpdir(), 'copies-'));

const TOTALS = [
  'export function totalOf(items: readonly { price: number; count: number }[]): number {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    if (item.count <= 0) continue;',
  '    total += item.price * item.count;',
  '  }',
  '  return Math.round(total * 100) / 100;',
  '}',
].join('\n');

const LABELS = [
  'export function labelOf(person: { first: string; last: string; title?: string }): string {',
  '  const parts = [person.title, person.first, person.last].filter((part) => part !== undefined && part.length > 0);',
  '  if (parts.length === 0) throw new Error(\'a person has a name\');',
  '  const label = parts.join(\' \');',
  '  return label.length > 40 ? `${label.slice(0, 39)}…` : label;',
  '}',
].join('\n');

const write = (file: string, text: string) => {
  mkdirSync(dirname(join(world, file)), { recursive: true });
  writeFileSync(join(world, file), `${text}\n`);
};

const audit = (...args: string[]) => {
  const run = spawnSync('npx', ['tsx', join(ROOT, 'tests/copies/audit.ts'), '--root', world, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
};

const baseline = () => JSON.parse(readFileSync(join(world, 'tests/copies/baseline.json'), 'utf8')) as Record<string, number>;

const marked = (authority: string) => `/**\n * ── DUPLICATED, KNOWINGLY ──\n * Authority: \`labelOf\` in ${authority}.\n */\n${LABELS}`;

afterAll(() => rmSync(world, { recursive: true, force: true }));

describe('the copied-code gate on a workspace of its own', () => {
  it('is seeded once with the copies there are, and refuses to be seeded again', () => {
    for (const folder of ['apps/backend/src', 'apps/frontend/src', 'apps/local-agent/src', 'packages/core/src', 'packages/cdktf-infra', 'tests']) mkdirSync(join(world, folder), { recursive: true });
    write('apps/backend/src/totals.ts', `export const unrelated = 1;\n\n${TOTALS}`);
    write('packages/core/src/totals.ts', TOTALS);
    write('apps/backend/src/totals.test.ts', ['import { expect, it } from \'vitest\';', 'import { totalOf } from \'./totals.js\';', '', 'it(\'adds what was bought\', () => {', '  expect(totalOf([{ price: 2, count: 3 }])).toBe(6);', '});'].join('\n'));
    const seeded = audit('--seed-baseline');
    expect(seeded).toMatchObject({ status: 0 });
    expect(Object.keys(baseline())).toEqual([expect.stringMatching(/^src apps\/backend\/src\/totals\.ts <-> packages\/core\/src\/totals\.ts #[0-9a-f]{12}$/)]);
    expect(audit('--seed-baseline').status).toBe(1);
    expect(audit()).toMatchObject({ status: 0 });
  }, 0);

  it('fails a new copy, naming both files and their lines', () => {
    write('apps/backend/src/labels.ts', LABELS);
    write('packages/core/src/labels.ts', `export const spacer = 2;\n\n${LABELS}`);
    const run = audit('--prune');
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/new copy in src: apps\/backend\/src\/labels\.ts:1-6 <-> packages\/core\/src\/labels\.ts:3-8/);
    expect(Object.keys(baseline())).toHaveLength(1);
  }, 0);

  it('exempts a marked copy only when the marker names the other file', () => {
    write('packages/core/src/labels.ts', marked('apps/frontend/src/people.ts'));
    const wrong = audit();
    expect(wrong.status).toBe(1);
    expect(wrong.out).toMatch(/packages\/core\/src\/labels\.ts:5 is marked, but its authority does not name apps\/backend\/src\/labels\.ts/);
    write('packages/core/src/labels.ts', marked('apps/backend/src/labels.ts'));
    expect(audit()).toMatchObject({ status: 0 });
  }, 0);

  it('carries a copy whose file moved, as the same copy', () => {
    renameSync(join(world, 'packages/core/src/totals.ts'), join(world, 'packages/core/src/sums.ts'));
    const run = audit('--prune');
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/moved: .*packages\/core\/src\/totals\.ts.* -> .*packages\/core\/src\/sums\.ts/);
    expect(Object.keys(baseline())).toEqual([expect.stringContaining('packages/core/src/sums.ts')]);
  }, 0);

  it('fails a fixed copy until it is pruned, and pruning shrinks the baseline', () => {
    write('packages/core/src/sums.ts', 'export const sum = (a: number, b: number): number => a + b;');
    const fixed = audit();
    expect(fixed.status).toBe(1);
    expect(fixed.out).toMatch(/fixed, prune it: src apps\/backend\/src\/totals\.ts <-> packages\/core\/src\/sums\.ts/);
    expect(audit('--prune')).toMatchObject({ status: 0 });
    expect(baseline()).toEqual({});
  }, 0);

  it('fails a copy that comes back after it was pruned', () => {
    write('packages/core/src/sums.ts', TOTALS);
    expect(audit('--prune').status).toBe(1);
    expect(baseline()).toEqual({});
  }, 0);
});
