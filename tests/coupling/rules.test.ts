import { describe, expect, it } from 'vitest';
import type { Edge, Graph, Unit } from './graph.js';
import type { Covered, Judged } from './join.js';
import { against, breaches, counted, introducedBy, judging, layerBreaches, pruned } from './rules.js';

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

describe('what each rule needs', () => {
  it('judges R4 from the graph alone and skips the rest, naming what is missing', () => {
    expect(judging(new Set())).toEqual({ judged: ['R4'], skipped: [{ rule: 'R1', missing: ['in-process'] }, { rule: 'R2', missing: ['in-process'] }, { rule: 'R3', missing: ['in-process'] }, { rule: 'R5', missing: ['in-process', 'live'] }] });
    expect(judging(new Set(['in-process'])).judged).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(judging(new Set(['in-process', 'live'])).judged).toEqual(['R1', 'R2', 'R3', 'R4', 'R5']);
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
    edges: [], unresolved: [], unmatched: [],
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
});

describe('a breach that comes back in code nobody changed', () => {
  it('fails only where the code changed since the baseline, and names the rest', () => {
    const added = [
      { rule: 'R2' as const, key: 'R2 a', at: 'apps/backend/src/hub/services/Changed.ts:12', why: '' },
      { rule: 'R5' as const, key: 'R5 b', at: 'apps/backend/src/hub/services/Untouched.ts:3', why: '' },
    ];
    const { introduced, flickered } = introducedBy(added, new Set(['apps/backend/src/hub/services/Changed.ts']));
    expect(introduced.map((breach) => breach.key)).toEqual(['R2 a']);
    expect(flickered.map((breach) => breach.key)).toEqual(['R5 b']);
  });
});
