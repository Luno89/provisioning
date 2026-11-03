import { describe, expect, it } from 'vitest';
import type { Ran, RanRange } from './collect.js';
import type { Graph, Unit } from './graph.js';
import { judge, unitLevels, type Level } from './join.js';

const unit = (id: string, file: string, name: string, line: number, inTest = false): Unit => ({ id, file, name, line, column: 1, start: 0, end: 0, inTest });
const site = (file: string, line: number) => ({ file, line, column: 5, start: 0, end: 0 });

const CALLER = 'apps/backend/src/a/caller.ts';
const CALLEE = 'apps/backend/src/b/callee.ts';
const ENTRY = 'apps/backend/src/c/entry.ts';

const graph: Graph = {
  units: {
    entry: unit('entry', ENTRY, 'entry', 1),
    caller: unit('caller', CALLER, 'caller', 1),
    callee: unit('callee', CALLEE, 'callee', 1),
  },
  edges: [
    { from: 'entry', site: site(ENTRY, 3), to: ['caller'], through: 'call' },
    { from: 'caller', site: site(CALLER, 5), to: ['callee'], through: 'interface' },
  ],
  unresolved: [],
  unmatched: [],
};

const ran = (count: number, from: number, to: number, fn?: string): RanRange => ({ start: { line: from, column: 1 }, end: { line: to, column: 80 }, count, ...(fn ? { fn } : {}) });

const LEVELS: Record<string, Level> = { 'unit.test.ts': 'unit', 'component.test.ts': 'component', 'fake.test.ts': 'unit', 'branch.test.ts': 'unit' };
const levelOf = (testFile: string): Level => LEVELS[testFile]!;

describe('the join', () => {
  const runs: Ran[] = [
    { testFile: 'unit.test.ts', files: { [CALLER]: [ran(1, 1, 10, 'caller')], [CALLEE]: [ran(1, 1, 10, 'callee')] } },
    { testFile: 'component.test.ts', files: { [ENTRY]: [ran(1, 1, 10, 'entry')], [CALLER]: [ran(1, 1, 10, 'caller')], [CALLEE]: [ran(1, 1, 10, 'callee')] } },
    { testFile: 'fake.test.ts', files: { [CALLER]: [ran(1, 1, 10, 'caller')], [CALLEE]: [ran(0, 1, 10, 'callee')] } },
    { testFile: 'branch.test.ts', files: { [CALLER]: [ran(1, 1, 10, 'caller'), ran(0, 4, 6)], [CALLEE]: [ran(1, 1, 10, 'callee')] } },
  ];
  const [intoCaller, intoCallee] = judge(graph, runs, levelOf);

  it('covers an edge only in a test that ran the call site and the real callee', () => {
    expect(intoCallee!.covered.map((entry) => entry.test)).toEqual(['unit.test.ts', 'component.test.ts']);
  });

  it('gives the lowest level, and the lowest level where its caller was real too', () => {
    expect(intoCallee).toMatchObject({ crosses: 'area', lowest: 'unit', withCallerAt: 'component' });
  });

  it('counts an entry point\'s edge with no caller of its own as never covered with a caller', () => {
    expect(intoCaller).toMatchObject({ lowest: 'component', withCallerAt: undefined });
  });
});

describe('which functions a test ran', () => {
  const at = (line: number, column: number) => ({ line, column });
  const FILE = 'apps/backend/src/a/remote.ts';
  const units = (...list: Unit[]): Graph => ({ units: Object.fromEntries(list.map((entry) => [entry.id, entry])), edges: [], unresolved: [], unmatched: [] });
  const callback = (id: string, line: number, column: number, ends: { line: number; column: number }): Unit => ({ ...unit(id, FILE, '(anonymous)', line), column, ends });

  it('finds a function by where it ends, since its range can start where the line before it ends or after an export', () => {
    const graph = units(
      { ...unit('outer', FILE, 'outer', 1), ends: at(20, 2) },
      callback('answered', 14, 15, at(14, 135)),
      callback('refused', 15, 15, at(15, 100)),
    );
    const runs: Ran[] = [{ testFile: 'unit.test.ts', files: { [FILE]: [
      { start: at(1, 8), end: at(20, 2), count: 1, fn: 'outer' },
      { start: at(13, 67), end: at(14, 134), count: 2, fn: '' },
      { start: at(14, 134), end: at(15, 100), count: 0, fn: '' },
    ] } }];
    const levels = unitLevels(graph, runs, levelOf);
    expect([...(levels.get('answered') ?? [])]).toEqual(['unit']);
    expect(levels.get('refused')).toBeUndefined();
    expect([...(levels.get('outer') ?? [])]).toEqual(['unit']);
  });

  it('counts a function run when any process that loaded its file ran it', () => {
    const graph = units({ ...unit('removeAll', FILE, 'removeAll', 138), column: 5, ends: at(142, 6) });
    const copy = (count: number): RanRange => ({ start: at(138, 5), end: at(142, 5), count, fn: 'removeAll' });
    const levels = unitLevels(graph, [{ testFile: 'component.test.ts', files: { [FILE]: [copy(0), copy(2), copy(0)] } }], levelOf);
    expect([...(levels.get('removeAll') ?? [])]).toEqual(['component']);
  });
});
