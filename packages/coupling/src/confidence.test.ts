import { describe, expect, it } from 'vitest';
import { judge, reportOf, type Codebase, type Weights } from './confidence.js';

const WEIGHTS: Weights = { unit: 0.5, component: 0.6, contract: 0.7, container: 0.8, vm: 0.9 };

const codebase = (over: Partial<Codebase> = {}): Codebase => ({
  units: [
    { id: 'save', file: 'a.ts', name: 'save', line: 1 },
    { id: 'store', file: 'b.ts', name: 'store', line: 1 },
    { id: 'orphan', file: 'c.ts', name: 'orphan', line: 1 },
  ],
  links: [],
  runs: [],
  changed: [],
  ...over,
});

describe('how proven a link is', () => {
  it('adds up what each layer that proves a link removes, so a unit test and a component test leave less risk than either alone', () => {
    const links = [{ id: 'save->store', from: 'save', to: ['store'], kind: 'composition' as const }];
    const one = judge(codebase({ links, runs: [{ test: 'u', layer: 'unit', units: ['save', 'store'], links: ['save->store'] }] }), WEIGHTS);
    const two = judge(codebase({ links, runs: [
      { test: 'u', layer: 'unit', units: ['save', 'store'], links: ['save->store'] },
      { test: 'c', layer: 'component', units: ['save', 'store'], links: ['save->store'] },
    ] }), WEIGHTS);

    expect(one.links[0]!.confidence).toBeCloseTo(0.5);
    expect(two.links[0]!.confidence).toBeCloseTo(1 - 0.5 * 0.4);
    expect(two.links[0]!.provenAt).toEqual(['unit', 'component']);
  });

  it('counts a layer once however many of its tests prove the link', () => {
    const links = [{ id: 'save->store', from: 'save', to: ['store'], kind: 'logic' as const }];
    const judged = judge(codebase({ links, runs: [
      { test: 'u1', layer: 'unit', units: ['save', 'store'], links: ['save->store'] },
      { test: 'u2', layer: 'unit', units: ['save', 'store'], links: ['save->store'] },
    ] }), WEIGHTS);

    expect(judged.links[0]!.confidence).toBeCloseTo(0.5);
    expect(judged.links[0]!.provenBy).toEqual(['u1', 'u2']);
  });

  it('proves a dependency only against the real thing, so a unit test over a fake leaves it unproven', () => {
    const links = [{ id: 'store->mongo', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'] }];
    const judged = judge(codebase({ links, runs: [{ test: 'u', layer: 'unit', units: ['store'], links: ['store->mongo'] }] }), WEIGHTS);

    expect(judged.links[0]!.confidence).toBe(0);
    expect(judged.links[0]!.provenAt).toEqual([]);
  });

  it('proves a dependency from the lowest layer that runs the real thing, so the test run\'s own real Mongo at component counts', () => {
    const links = [{ id: 'store->mongo', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'], realFrom: 'component' as const }];
    const judged = judge(codebase({ links, runs: [
      { test: 'u', layer: 'unit', units: ['store'], links: ['store->mongo'] },
      { test: 'c', layer: 'component', units: ['store'], links: ['store->mongo'] },
    ] }), WEIGHTS);

    expect(judged.links[0]!.provenAt).toEqual(['component']);
  });

  it('lends a dependency the proof of a proven sibling by how much of their path they share, so an e2e add lowers the risk of an unrun delete', () => {
    const links = [
      { id: 'add', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'] },
      { id: 'delete', from: 'store', to: ['pkg:mongodb#deleteOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'deleteOne'] },
      { id: 'other', from: 'store', to: ['pkg:redis#get'], kind: 'dependency' as const, path: ['redis', 'cache', 'get'] },
    ];
    const judged = judge(codebase({ links, runs: [{ test: 'vm', layer: 'vm', units: ['store'], links: ['add'] }] }), WEIGHTS);
    const of = (id: string) => judged.links.find((link) => link.id === id)!;

    expect(of('add').confidence).toBeCloseTo(0.9);
    expect(of('delete').confidence).toBeCloseTo(0.9 * (2 / 3));
    expect(of('delete').sharedFrom).toBe('add');
    expect(of('other').confidence).toBe(0);
  });

  it('weighs what a sibling shares by the parts of its path, so one proven call through a client and its connection lends most of its proof to the client\'s other commands', () => {
    const links = [
      { id: 'add', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'] },
      { id: 'delete', from: 'store', to: ['pkg:mongodb#deleteOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'deleteOne'] },
      { id: 'elsewhere', from: 'store', to: ['pkg:mongodb#find'], kind: 'dependency' as const, path: ['mongodb', 'notes', 'find'] },
    ];
    const judged = judge(codebase({ links, runs: [{ test: 'vm', layer: 'vm', units: ['store'], links: ['add'] }] }), WEIGHTS, { service: 0.6, resource: 0.2, operation: 0.2 });
    const of = (id: string) => judged.links.find((link) => link.id === id)!;

    expect(of('delete').confidence).toBeCloseTo(0.9 * 0.8);
    expect(of('elsewhere').confidence).toBeCloseTo(0.9 * 0.6);
  });

  it('counts a dependency\'s proof only at the version it runs today, so neither the link nor its siblings keep a proof made against another version', () => {
    const links = [
      { id: 'add', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'] },
      { id: 'delete', from: 'store', to: ['pkg:mongodb#deleteOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'deleteOne'] },
    ];
    const judged = judge(codebase({ links, versions: { mongodb: '6.12.0' }, runs: [{ test: 'vm', layer: 'vm', units: ['store'], links: ['add'], versions: { mongodb: '6.10.0' } }] }), WEIGHTS);

    expect(judged.links.map((link) => link.confidence)).toEqual([0, 0]);
  });

  it('drops a run\'s proof of code that changed since it ran, on either side of a link', () => {
    const links = [{ id: 'save->store', from: 'save', to: ['store'], kind: 'composition' as const }];
    const judged = judge(codebase({ links, runs: [{ test: 'c', layer: 'component', units: ['save', 'store'], links: ['save->store'], expired: ['store'] }] }), WEIGHTS);

    expect(judged.links[0]!.confidence).toBe(0);
    expect(judged.untested.map((unit) => unit.id)).toEqual(['orphan', 'store']);
  });

  it('ranks functions by what every layer that runs them leaves, untested ones first', () => {
    const judged = judge(codebase({ runs: [
      { test: 'u', layer: 'unit', units: ['save', 'store'], links: [] },
      { test: 'c', layer: 'component', units: ['save'], links: [] },
    ] }), WEIGHTS);

    expect(judged.functions.map((one) => [one.id, one.runAt])).toEqual([['orphan', []], ['store', ['unit']], ['save', ['unit', 'component']]]);
    expect(judged.functions[2]!.confidence).toBeCloseTo(1 - 0.5 * 0.4);
  });

  it('ranks links riskiest first, weighing what is left by how often the code changed and failed', () => {
    const links = [
      { id: 'calm', from: 'save', to: ['store'], kind: 'logic' as const },
      { id: 'busy', from: 'store', to: ['save'], kind: 'logic' as const },
    ];
    const judged = judge(codebase({ links, history: { changes: { store: 255 }, failures: { store: 1 } } }), WEIGHTS);

    expect(judged.links.map((link) => link.id)).toEqual(['busy', 'calm']);
    expect(judged.links[0]!.risk).toBeCloseTo((1 + Math.log2(256)) * 2);
  });
});

describe('code no test runs', () => {
  it('blocks new or changed code no test runs, and lists the rest of the untested code to shrink', () => {
    const judged = judge(codebase({
      runs: [{ test: 'u', layer: 'unit', units: ['save'], links: [] }],
      changed: ['store', 'save'],
    }), WEIGHTS);

    expect(judged.blocking.map((unit) => unit.id)).toEqual(['store']);
    expect(judged.untested.map((unit) => unit.id)).toEqual(['orphan', 'store']);
  });

  it('counts a run from any layer, the daily VM run included, as running the code', () => {
    const judged = judge(codebase({ runs: [{ test: 'daily', layer: 'vm', units: ['save', 'store', 'orphan'], links: [] }], changed: ['orphan'] }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
    expect(judged.untested).toEqual([]);
  });
});

describe('the report', () => {
  it('counts links by kind, proven and lent apart, lists the riskiest links and functions, and names the changed code no test runs', () => {
    const links = [
      { id: 'a.ts:2', from: 'save', to: ['store'], kind: 'composition' as const },
      { id: 'a.ts:3', from: 'save', to: ['store'], kind: 'logic' as const },
      { id: 'b.ts:4', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'insertOne'] },
      { id: 'b.ts:5', from: 'store', to: ['pkg:mongodb#deleteOne'], kind: 'dependency' as const, path: ['mongodb', 'users', 'deleteOne'] },
    ];
    const judged = judge(codebase({ links, runs: [{ test: 'u', layer: 'unit', units: ['save'], links: ['a.ts:3'] }, { test: 'v', layer: 'vm', units: [], links: ['b.ts:4'] }], changed: ['store'] }), WEIGHTS);

    expect(reportOf(judged, 1).split('\n')).toEqual([
      '4 links: logic 1 (1 proven), composition 1 (0 proven), dependency 2 (1 proven, 1 lent)',
      '2 of 3 functions no test runs',
      'riskiest links:',
      '  1.00  a.ts:2 composition, proven nowhere',
      'riskiest functions:',
      '  1.00  b.ts:1 store, run nowhere',
      'changed code no test runs (blocks):',
      '  b.ts:1 store',
    ]);
  });
});
