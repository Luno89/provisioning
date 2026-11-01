import { describe, expect, it } from 'vitest';
import type { Ran, RanRange } from './collect.js';
import type { Graph, Unit } from './graph.js';
import { judge, type Level } from './join.js';

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
