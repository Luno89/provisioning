import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Unit } from './graph.js';
import type { Covered, Judged } from './join.js';
import { against, breaches, counted, judging, layerBreaches, movedIn, pruned, type Breach } from './rules.js';

const unit = (id: string, file: string): Unit => ({ id, file, name: id, line: 1, column: 1, start: 0, end: 0, inTest: false });
const edge = (from: string, to: string[], through: Edge['through'], line: number): Edge => ({ from, to, through, site: { file: `apps/backend/src/x/${from}.ts`, line, column: 1, start: 0, end: 0 } });
const by = (level: Covered['level'], withCaller = false): Covered => ({ test: `${level}.test.ts`, level, withCaller });

const graph: Graph = {
  units: Object.fromEntries(['route', 'service', 'store', 'client', 'handler', 'worker', 'lonely'].map((id) => [id, unit(id, `apps/backend/src/x/${id}.ts`)])),
  edges: [
    edge('route', ['service'], 'call', 1),
    edge('service', ['store'], 'interface', 2),
    edge('client', ['handler'], 'http', 3),
    edge('service', ['worker'], 'temporal', 4),
    edge('lonely', [], 'interface', 5),
  ],
  unresolved: [{ from: 'service', site: { file: 'apps/backend/src/x/service.ts', line: 9, column: 1, start: 0, end: 0 }, text: 'deps.thing', why: 'called through any' }],
  unmatched: [], records: [],
};

const judged = (covered: Covered[][]): Judged[] => graph.edges.map((entry, index) => {
  const list = covered[index] ?? [];
  const order = ['unit', 'component', 'contract', 'container', 'live', 'vm'];
  const rank = (level: string) => order.indexOf(level);
  return {
    edge: entry,
    crosses: 'area',
    covered: list,
    lowest: list.map((item) => item.level).sort((a, b) => rank(a) - rank(b))[0],
    withCallerAt: list.filter((item) => item.withCaller).map((item) => item.level).sort((a, b) => rank(a) - rank(b))[0],
  };
});

const rulesOf = (found: ReturnType<typeof breaches>) => found.map((breach) => `${breach.rule} ${breach.at}`);

describe('the rules', () => {
  it('passes an edge covered below the live suites together with its caller', () => {
    const found = breaches(judged([[by('component')], [by('component', true)], [by('component')], [by('component', true)]]), graph);
    expect(rulesOf(found)).toEqual(['R4 apps/backend/src/x/lonely.ts:5', 'R4 apps/backend/src/x/service.ts:9']);
  });

  it('breaks R1 for an edge only the live suites run, and says so', () => {
    const found = breaches(judged([[by('component')], [by('live', true)], [by('component')], [by('component', true)]]), graph);
    expect(found.find((breach) => breach.rule === 'R1')).toMatchObject({ at: 'apps/backend/src/x/service.ts:2', why: 'covered only at live' });
  });

  it('breaks R3, not R1, for a cross-process edge covered only live', () => {
    const found = breaches(judged([[by('component')], [by('component', true)], [by('live')], [by('component', true)]]), graph);
    expect(rulesOf(found).filter((rule) => !rule.startsWith('R4'))).toEqual(['R3 apps/backend/src/x/client.ts:3']);
  });

  it('counts an entry point\'s own edge as tested with its caller, and nothing else', () => {
    const found = breaches(judged([[by('component')], [by('component')], [by('component')], [by('component')]]), graph);
    expect(rulesOf(found).filter((rule) => rule.startsWith('R2'))).toEqual(['R2 apps/backend/src/x/service.ts:2', 'R2 apps/backend/src/x/service.ts:4']);
  });

  it('breaks R4 for a call with no implementation and one through any', () => {
    const found = breaches(judged([]), graph).filter((breach) => breach.rule === 'R4');
    expect(found.map((breach) => breach.key)).toEqual([
      'R4 apps/backend/src/x/lonely.ts#lonely ->  (interface)',
      'R4 apps/backend/src/x/service.ts#service -> deps.thing (called through any)',
    ]);
  });
});

describe('the baseline', () => {
  const today = breaches(judged([[by('component')], [by('live', true)], [by('component')], [by('component', true)]]), graph);
  const baseline = counted(today);

  it('lets through exactly what it lists', () => {
    expect(against(today, baseline)).toEqual({ added: [], fixed: [] });
  });

  it('fails a breach it does not list, and a second of one it lists once', () => {
    const worse = [...today, { ...today[0]!, at: 'apps/backend/src/x/route.ts:7' }, { rule: 'R1' as const, key: 'R1 new -> edge (call)', at: 'a.ts:1', why: 'no test runs both sides for real' }];
    expect(against(worse, baseline).added.map((breach) => breach.at)).toEqual(['apps/backend/src/x/route.ts:7', 'a.ts:1']);
  });

  it('names what was fixed, and pruning only ever lowers it', () => {
    const better = today.filter((breach) => breach.rule !== 'R1');
    expect(against(better, baseline).fixed).toEqual([{ key: today.find((breach) => breach.rule === 'R1')!.key, was: 1, now: 0 }]);
    const after = pruned(baseline, [...better, { rule: 'R1', key: 'R1 new -> edge (call)', at: 'a.ts:1', why: '' }]);
    expect(Object.keys(after)).toEqual(Object.keys(counted(better)));
  });

  it('calls nothing fixed that only a live suite clears, since only the tiers below live lower it', () => {
    const live = today.filter((breach) => breach.rule !== 'R1');
    expect(against(live, baseline, undefined, today)).toEqual({ added: [], fixed: [] });
    expect(against(today, baseline, undefined, live).fixed.map((entry) => entry.now)).toEqual([0]);
  });
});

describe('what each rule needs', () => {
  it('judges R4 from the graph alone and skips the rest, naming what is missing', () => {
    expect(judging(new Set())).toEqual({ judged: ['R4'], skipped: [{ rule: 'R1', missing: ['in-process'] }, { rule: 'R2', missing: ['in-process'] }, { rule: 'R3', missing: ['in-process'] }, { rule: 'R5', missing: ['in-process'] }] });
    expect(judging(new Set(['in-process'])).judged).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
  });

  it('holds only the rules it judged against the baseline, and prunes nothing else', () => {
    const all = breaches(judged([[by('component')], [by('live', true)], [by('component')], [by('component', true)]]), graph);
    const baseline = counted(all);
    const onlyR4 = breaches(judged([]), graph, ['R4']);
    expect(onlyR4.every((breach) => breach.rule === 'R4')).toBe(true);
    expect(against(onlyR4, baseline, ['R4'])).toEqual({ added: [], fixed: [] });
    expect(pruned(baseline, onlyR4, ['R4'])).toEqual(baseline);
  });
});

describe('R5, the layers a service, route or activity is tested at', () => {
  const layered: Graph = {
    units: Object.fromEntries([
      ['both', 'apps/backend/src/hub/services/Both.ts'],
      ['mocked', 'apps/backend/src/hub/services/Mocked.ts'],
      ['real', 'apps/backend/src/hub/routes/real.ts'],
      ['lived', 'apps/backend/src/activities/Lived.ts'],
      ['never', 'apps/backend/src/hub/services/Never.ts'],
      ['pure', 'apps/backend/src/hub/lib/pure.ts'],
    ].map(([id, file]) => [id!, unit(id!, file!)])),
    edges: [], unresolved: [], unmatched: [], records: [],
  };
  const levels = new Map<string, Set<Covered['level']>>([
    ['both', new Set(['unit', 'component'])],
    ['mocked', new Set(['unit'])],
    ['real', new Set(['component'])],
    ['lived', new Set(['unit', 'live'])],
    ['pure', new Set(['unit'])],
  ]);

  it('passes code run by a unit test and by an integration or live one, and holds lib to neither', () => {
    expect(layerBreaches(layered, levels).map((breach) => [breach.key, breach.why])).toEqual([
      ['R5 apps/backend/src/hub/services/Mocked.ts#mocked', 'no integration or live test runs it with its real dependencies'],
      ['R5 apps/backend/src/hub/routes/real.ts#real', 'no unit test runs it with its dependencies mocked'],
      ['R5 apps/backend/src/hub/services/Never.ts#never', 'no test runs it'],
    ]);
  });

  it('judges startup code as any other code: what the live stack ran counts for nothing, since its state differs from run to run', () => {
    const started: Graph = {
      units: {
        main: unit('main', 'apps/backend/src/worker-engine.ts'),
        wire: unit('wire', 'apps/backend/src/hub/wiring/hub.ts'),
        service: unit('service', 'apps/backend/src/x/service.ts'),
        store: unit('store', 'apps/backend/src/x/store.ts'),
      },
      edges: [edge('main', ['service'], 'call', 1), edge('wire', ['service'], 'temporal', 2), edge('service', ['store'], 'interface', 3)],
      unresolved: [],
      unmatched: [], records: [],
    };
    const live = [by('live', true)];
    const found = breaches(started.edges.map((entry) => ({ edge: entry, crosses: 'area' as const, covered: live, lowest: 'live' as const, withCallerAt: 'live' as const })), started);
    expect(rulesOf(found)).toEqual(['R1 apps/backend/src/x/main.ts:1', 'R3 apps/backend/src/x/wire.ts:2', 'R1 apps/backend/src/x/service.ts:3']);
    const booted = breaches(started.edges.map((entry) => ({ edge: entry, crosses: 'area' as const, covered: [by('component', true)], lowest: 'component' as const, withCallerAt: 'component' as const })), started);
    expect(rulesOf(booted)).toEqual([]);
    const unrun = breaches(started.edges.map((entry) => ({ edge: entry, crosses: 'area' as const, covered: [], lowest: undefined, withCallerAt: undefined })), started);
    expect(rulesOf(unrun).filter((line) => !line.startsWith('R2'))).toEqual(['R1 apps/backend/src/x/main.ts:1', 'R3 apps/backend/src/x/wire.ts:2', 'R1 apps/backend/src/x/service.ts:3']);
  });
});

describe('a breach whose callee moved', () => {
  const key = (rule: string, from: string, to: string, through = 'call') => `${rule} ${from} -> ${to} (${through})`;
  const breach = (rule: 'R1' | 'R2', from: string, to: string): Breach => ({ rule, key: key(rule, from, to), at: 'x.ts:1', why: 'no test runs both sides for real' });

  it('carries its count to the callee\'s new file when the caller, rule, call and function name are the same, saying so', () => {
    const baseline = { [key('R1', 'a.ts#run', 'old/deps.ts#failureOf')]: 2, [key('R1', 'a.ts#run', 'b.ts#other')]: 1 };
    const found = [breach('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'), breach('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'), breach('R1', 'a.ts#run', 'b.ts#other')];
    const { baseline: carried, moves } = movedIn(baseline, found);
    expect(moves).toEqual([{ from: key('R1', 'a.ts#run', 'old/deps.ts#failureOf'), to: key('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'), count: 2 }]);
    expect(carried).toEqual({ [key('R1', 'a.ts#run', 'pkg/failures.ts#failureOf')]: 2, [key('R1', 'a.ts#run', 'b.ts#other')]: 1 });
    expect(against(found, carried).added).toEqual([]);
  });

  it('lets in nothing new: a third call after a move, another function, another caller or another rule is still new', () => {
    const baseline = { [key('R1', 'a.ts#run', 'old/deps.ts#failureOf')]: 1 };
    const found = [breach('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'), breach('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'), breach('R1', 'a.ts#run', 'pkg/failures.ts#somethingElse'), breach('R2', 'a.ts#run', 'pkg/failures.ts#failureOf'), breach('R1', 'c.ts#go', 'pkg/failures.ts#failureOf')];
    const { baseline: carried } = movedIn(baseline, found);
    expect(against(found, carried).added.map((added) => added.key).sort()).toEqual([
      key('R1', 'a.ts#run', 'pkg/failures.ts#failureOf'),
      key('R1', 'a.ts#run', 'pkg/failures.ts#somethingElse'),
      key('R1', 'c.ts#go', 'pkg/failures.ts#failureOf'),
      key('R2', 'a.ts#run', 'pkg/failures.ts#failureOf'),
    ]);
  });

  it('moves nothing while the old breach is still there', () => {
    const baseline = { [key('R1', 'a.ts#run', 'old/deps.ts#failureOf')]: 1 };
    const found = [breach('R1', 'a.ts#run', 'old/deps.ts#failureOf'), breach('R1', 'a.ts#run', 'pkg/failures.ts#failureOf')];
    expect(movedIn(baseline, found).moves).toEqual([]);
  });
});

describe('a breach whose caller was renamed or moved within its file', () => {
  const key = (rule: string, from: string, to: string, through = 'call') => `${rule} ${from} -> ${to} (${through})`;
  const breach = (rule: 'R1' | 'R2', from: string, to: string): Breach => ({ rule, key: key(rule, from, to), at: 'x.ts:1', why: 'no test runs both sides for real' });

  it('carries its count when the caller has a new name in the same file and calls the same function', () => {
    const baseline = { [key('R1', 'w.ts#main', 'd.ts#DependencyStates.failed')]: 1 };
    const found = [breach('R1', 'w.ts#startWorker', 'd.ts#DependencyStates.failed')];
    expect(movedIn(baseline, found).moves).toEqual([{ from: key('R1', 'w.ts#main', 'd.ts#DependencyStates.failed'), to: key('R1', 'w.ts#startWorker', 'd.ts#DependencyStates.failed'), count: 1 }]);
  });

  it('carries nothing for a caller in another file, or a call to another function', () => {
    const baseline = { [key('R1', 'w.ts#main', 'd.ts#DependencyStates.failed')]: 1 };
    expect(movedIn(baseline, [breach('R1', 'v.ts#main', 'd.ts#DependencyStates.failed')]).moves).toEqual([]);
    expect(movedIn(baseline, [breach('R1', 'w.ts#startWorker', 'd.ts#DependencyStates.answered')]).moves).toEqual([]);
  });

  it('carries only as many as there were: a second call where one was is new', () => {
    const baseline = { [key('R1', 's.ts#S.applyRootRules', 'a.ts#apply', 'interface')]: 1 };
    const found = [breach('R1', 's.ts#S.applyOwnRules', 'a.ts#apply'), breach('R1', 's.ts#S.applyOwnRules', 'a.ts#apply')].map((entry) => ({ ...entry, key: key('R1', 's.ts#S.applyOwnRules', 'a.ts#apply', 'interface') }));
    const { baseline: carried } = movedIn(baseline, found);
    expect(against(found, carried).added).toHaveLength(1);
  });
});
