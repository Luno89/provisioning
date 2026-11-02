import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Unit } from './graph.js';
import type { Covered, Judged } from './join.js';
import { against, breaches, counted, pruned } from './rules.js';

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
  unmatched: [],
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
});
