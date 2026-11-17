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
  unmatched: [], records: [],
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
  const units = (...list: Unit[]): Graph => ({ units: Object.fromEntries(list.map((entry) => [entry.id, entry])), edges: [], unresolved: [], unmatched: [], records: [] });
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

  it('judges a call site in each copy of its function apart, since V8 leaves out a block that ran as often as its function', () => {
    const graph: Graph = { units: { caller: { ...unit('caller', FILE, 'caller', 10), ends: at(20, 2) }, callee: unit('callee', CALLEE, 'callee', 1) }, edges: [{ from: 'caller', site: { file: FILE, line: 15, column: 5, start: 0, end: 0 }, to: ['callee'], through: 'call' }], unresolved: [], unmatched: [], records: [] };
    const caller = (count: number, loop?: number): RanRange[] => [{ start: at(10, 1), end: at(20, 1), count, fn: 'caller' }, ...(loop === undefined ? [] : [{ start: at(13, 3), end: at(17, 3), count: loop }])];
    const files = { [FILE]: [...caller(1, 0), ...caller(1), ...caller(1, 0)], [CALLEE]: [{ start: at(1, 1), end: at(5, 1), count: 1, fn: 'callee' }] };
    const [judged] = judge(graph, [{ testFile: 'component.test.ts', files }], levelOf);
    expect(judged!.covered.map((entry) => entry.test)).toEqual(['component.test.ts']);
  });
});

describe('an edge inside a workflow, which Temporal starts by name', () => {
  const STARTER = 'apps/backend/src/a/starter.ts';
  const WORKFLOW = 'apps/backend/src/workflows/deploy.ts';
  const ACTIVITY = 'apps/backend/src/activities/check.ts';
  const started: Graph = {
    units: {
      starter: unit('starter', STARTER, 'startDeploy', 1),
      workflow: unit('workflow', WORKFLOW, 'deployWorkflow', 1),
      activity: unit('activity', ACTIVITY, 'CheckActivity', 1),
    },
    edges: [
      { from: 'starter', site: site(STARTER, 5), to: ['workflow'], through: 'temporal' },
      { from: 'workflow', site: site(WORKFLOW, 4), to: ['activity'], through: 'temporal' },
    ],
    unresolved: [],
    unmatched: [], records: [],
  };
  const starterRan: Ran = { testFile: 'unit.test.ts', files: { [STARTER]: [ran(1, 1, 10, 'startDeploy')] } };
  const workflowRan: Ran = { testFile: 'component.test.ts', files: { [WORKFLOW]: [ran(1, 1, 10, 'deployWorkflow')], [ACTIVITY]: [ran(1, 1, 10, 'CheckActivity')] } };

  it('is tested with its caller once one test runs the workflow into the activity and another runs the starter where it starts the workflow', () => {
    const [, intoActivity] = judge(started, [starterRan, workflowRan], levelOf);
    expect(intoActivity).toMatchObject({ lowest: 'component', withCallerAt: 'component' });
  });

  it('is not, while no test runs the starter where it starts the workflow', () => {
    const [, intoActivity] = judge(started, [workflowRan], levelOf);
    expect(intoActivity).toMatchObject({ lowest: 'component', withCallerAt: undefined });
  });
});

describe('the tests that came close to a call no test runs for real', () => {
  const STANDIN = 'apps/backend/src/b/callee.test-double.ts';
  const near: Graph = {
    units: {
      caller: unit('caller', CALLER, 'caller', 1),
      callee: unit('callee', CALLEE, 'callee', 1),
      double: unit('double', STANDIN, 'double', 1, true),
      above: unit('above', ENTRY, 'above', 1),
    },
    edges: [
      { from: 'above', site: site(ENTRY, 3), to: ['caller'], through: 'call' },
      { from: 'caller', site: site(CALLER, 5), to: ['callee', 'double'], through: 'interface' },
    ],
    unresolved: [], unmatched: [], records: [],
  };
  const runs: Ran[] = [
    { testFile: 'unit.test.ts', files: { [CALLER]: [ran(1, 1, 10, 'caller')], [STANDIN]: [ran(1, 1, 10, 'double')] } },
    { testFile: 'component.test.ts', files: { [CALLEE]: [ran(1, 1, 10, 'callee')] } },
    { testFile: 'fake.test.ts', files: { [ENTRY]: [ran(1, 1, 10, 'above')] } },
  ];

  it('names the tests that ran its caller, its real target, a stand-in in its place, and what calls its caller', () => {
    const [, call] = judge(near, runs, levelOf);
    expect(call!.near).toEqual({ callerRan: ['unit.test.ts'], targetRan: ['component.test.ts'], standIn: ['unit.test.ts'], callersOfCallerRan: ['fake.test.ts'], siteRan: ['unit.test.ts'] });
  });

  it('names the branch a test ran the caller without taking, where the call sits', () => {
    const skipped: Ran[] = [{ testFile: 'branch.test.ts', files: { [CALLER]: [ran(1, 1, 10, 'caller'), ran(0, 4, 6)], [CALLEE]: [ran(1, 1, 10, 'callee')] } }];
    const [, call] = judge(near, skipped, levelOf);
    expect(call!.near).toMatchObject({ callerRan: ['branch.test.ts'], siteRan: [], untaken: { from: 4, to: 6, test: 'branch.test.ts' } });
  });
});
