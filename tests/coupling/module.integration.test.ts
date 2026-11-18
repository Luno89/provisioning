import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCollecting, type Ran } from './collect.js';
import { buildGraph, isTest, type Graph } from './graph.js';
import { judge, type Judged } from './join.js';

const FIXTURE = join(import.meta.dirname, 'fixture-module');
const SCRIPT = join(FIXTURE, 'src', 'script.ts');
const TSX = join(import.meta.dirname, '..', '..', 'node_modules', '.bin', 'tsx');
const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gathered = (dir: string): Ran[] => readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Ran);

async function ranWhile(act: (env: Record<string, string>) => Promise<void>): Promise<Ran[]> {
  const dir = mkdtempSync(join(tmpdir(), 'koala-module-'));
  dirs.push(dir);
  const collector = await startCollecting({ dir, root: FIXTURE, keep: (file) => file.startsWith('src/'), children: join(dir, 'children') });
  await act(collector.childEnv);
  await collector.take(join(FIXTURE, 'module.test.ts'));
  return gathered(dir);
}

describe('a module\'s top-level code, judged', () => {
  let graph: Graph;
  beforeAll(() => {
    graph = buildGraph({ projects: [{ tsconfig: join(FIXTURE, 'tsconfig.json'), owns: () => true }], root: FIXTURE, calledFrom: (file) => !isTest(file) });
  });
  const topLevelCallOn = (judged: readonly Judged[], line: number): Judged | undefined =>
    judged.find((entry) => graph.units[entry.edge.from]?.name === '(module)' && entry.edge.site.file === 'src/script.ts' && entry.edge.site.line === line && entry.edge.to.some((id) => graph.units[id]?.name === 'shout'));

  it('counts a top-level call as run when a test starts the script, and not one in a branch it never took', async () => {
    const runs = await ranWhile(async (env) => {
      expect(execFileSync(TSX, [SCRIPT], { encoding: 'utf8', env: { ...process.env, ...env } })).toBe('HELLO\n');
    });
    const judged = judge(graph, runs, () => 'component');
    expect(topLevelCallOn(judged, 3)?.covered.map((entry) => entry.level)).toEqual(['component']);
    expect(topLevelCallOn(judged, 6)?.covered).toEqual([]);
  });

  it('counts a top-level call as run when a test imports the module, and not one in a branch it never took', async () => {
    const runs = await ranWhile(async () => {
      await import(SCRIPT);
    });
    const judged = judge(graph, runs, () => 'component');
    expect(topLevelCallOn(judged, 3)?.covered.map((entry) => entry.level)).toEqual(['component']);
    expect(topLevelCallOn(judged, 6)?.covered).toEqual([]);
  });
});
