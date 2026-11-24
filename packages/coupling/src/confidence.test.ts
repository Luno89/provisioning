import { describe, expect, it } from 'vitest';
import { EVEN_SHARING, heldTo, judge, learnedWeights, reportOf, untestedList, type Codebase, type Weights } from './confidence.js';

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
    const judged = judge(codebase({ links, runs: [{ test: 'vm', layer: 'vm', units: ['store'], links: ['add'] }] }), WEIGHTS, { dependency: { service: 0.6, resource: 0.2, operation: 0.2 } });
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

  it('lowers the risk of a function no test runs by the proof its calls into a dependency borrow, so an e2e add makes the unrun delete less risky', () => {
    const judged = judge(codebase({
      units: [
        { id: 'add', file: 'store.ts', name: 'add', line: 1 },
        { id: 'remove', file: 'store.ts', name: 'remove', line: 5 },
        { id: 'orphan', file: 'c.ts', name: 'orphan', line: 1 },
      ],
      links: [
        { id: 'store.ts:2', from: 'add', to: ['pkg:mongodb#insertOne'], kind: 'dependency', path: ['mongodb', 'users', 'insertOne'] },
        { id: 'store.ts:6', from: 'remove', to: ['pkg:mongodb#deleteOne'], kind: 'dependency', path: ['mongodb', 'users', 'deleteOne'] },
      ],
      runs: [{ test: 'daily', layer: 'vm', units: ['add'], links: ['store.ts:2'] }],
    }), WEIGHTS);
    const of = (id: string) => judged.functions.find((one) => one.id === id)!;

    expect(of('remove').confidence).toBeCloseTo(0.9 * (2 / 3));
    expect(of('remove').lentBy).toBe('store.ts:2');
    expect(of('remove').risk).toBeLessThan(of('orphan').risk);
    expect(judged.untested.map((unit) => unit.id)).toEqual(['orphan', 'remove']);
  });

  it('ranks functions by what every layer that runs them leaves, untested ones first', () => {
    const judged = judge(codebase({ runs: [
      { test: 'u', layer: 'unit', units: ['save', 'store'], links: [] },
      { test: 'c', layer: 'component', units: ['save'], links: [] },
    ] }), WEIGHTS);

    expect(judged.functions.map((one) => [one.id, one.runAt])).toEqual([['orphan', []], ['store', ['unit']], ['save', ['unit', 'component']]]);
    expect(judged.functions[2]!.confidence).toBeCloseTo(1 - 0.5 * 0.4);
  });

  it('lends a link between Koala\'s own pieces part of the proof of a proven link into the same target, leaving the new caller\'s side unproven', () => {
    const links = [
      { id: 'save->store', from: 'save', to: ['store'], kind: 'composition' as const },
      { id: 'orphan->store', from: 'orphan', to: ['store'], kind: 'composition' as const },
      { id: 'orphan->save', from: 'orphan', to: ['save'], kind: 'composition' as const },
    ];
    const judged = judge(codebase({ links, runs: [{ test: 'c', layer: 'component', units: ['save', 'store'], links: ['save->store'] }] }), WEIGHTS, { dependency: EVEN_SHARING, composition: { target: 0.5 } });
    const of = (id: string) => judged.links.find((link) => link.id === id)!;

    expect(of('orphan->store').confidence).toBeCloseTo(0.6 * 0.5);
    expect(of('orphan->store').sharedFrom).toBe('save->store');
    expect(of('orphan->save').confidence).toBe(0);
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
    const judged = judge(codebase({
      links: [{ id: 'c.ts:2', from: 'orphan', to: ['pkg:mongodb#insertOne'], kind: 'dependency', path: ['mongodb', 'users', 'insertOne'] }],
      runs: [{ test: 'daily', layer: 'vm', units: ['save', 'store', 'orphan'], links: [] }],
      changed: ['orphan'],
    }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
    expect(judged.untested).toEqual([]);
  });

  it('says why each changed unit is refused', () => {
    const judged = judge(codebase({ runs: [{ test: 'u', layer: 'unit', units: ['save'], links: [] }], changed: ['store'] }), WEIGHTS);

    expect(judged.blocking).toEqual([{ id: 'store', file: 'b.ts', name: 'store', line: 1, reason: 'no test runs it' }]);
  });
});

describe('logic only a test above unit runs', () => {
  it('blocks changed logic that only a component run runs, saying it needs a unit test', () => {
    const judged = judge(codebase({ runs: [{ test: 'c', layer: 'component', units: ['save'], links: [] }], changed: ['save'] }), WEIGHTS);

    expect(judged.blocking).toEqual([{ id: 'save', file: 'a.ts', name: 'save', line: 1, reason: 'runs only at component; its logic needs a unit test' }]);
  });

  it('names every layer above unit that runs it', () => {
    const judged = judge(codebase({ runs: [{ test: 'v', layer: 'vm', units: ['save'], links: [] }, { test: 'k', layer: 'container', units: ['save'], links: [] }], changed: ['save'] }), WEIGHTS);

    expect(judged.blocking.map((unit) => unit.reason)).toEqual(['runs only at container, vm; its logic needs a unit test']);
  });

  it('lets changed logic through once a unit run runs it as well', () => {
    const judged = judge(codebase({ runs: [{ test: 'c', layer: 'component', units: ['save'], links: [] }, { test: 'u', layer: 'unit', units: ['save'], links: [] }], changed: ['save'] }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
  });

  it('lets a changed adapter that calls an outside service itself be proven at the layer of the real thing', () => {
    const judged = judge(codebase({
      links: [{ id: 'b.ts:2', from: 'store', to: ['pkg:@kubernetes/client-node#apply'], kind: 'dependency', path: ['@kubernetes/client-node', 'apply'] }],
      runs: [{ test: 'k', layer: 'container', units: ['store'], links: [] }],
      changed: ['store'],
    }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
  });

  it('lets an adapter method that reaches the outside service through a helper of its own file be proven at the layer of the real thing', () => {
    const judged = judge(codebase({
      units: [
        { id: 'byCode', file: 'store.ts', name: 'Store.getInviteByCode', line: 1 },
        { id: 'byHash', file: 'store.ts', name: 'Store.getInviteByHash', line: 5 },
      ],
      links: [
        { id: 'store.ts:2', from: 'byCode', to: ['byHash'], kind: 'logic' },
        { id: 'store.ts:6', from: 'byHash', to: ['pkg:mongodb#Collection.findOne'], kind: 'dependency', path: ['mongodb', 'invites', 'Collection.findOne'] },
      ],
      runs: [{ test: 'c', layer: 'component', units: ['byCode', 'byHash'], links: [] }],
      changed: ['byCode', 'byHash'],
    }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
  });

  it('lets a function written inside an adapter method, like the mapping of the documents it reads, be proven with it', () => {
    const judged = judge(codebase({
      units: [
        { id: 'getInvites', file: 'store.ts', name: 'Store.getInvites', line: 1 },
        { id: 'mapped', file: 'store.ts', name: '(anonymous)', line: 2, within: 'getInvites' },
      ],
      links: [{ id: 'store.ts:2', from: 'getInvites', to: ['pkg:mongodb#Collection.find'], kind: 'dependency', path: ['mongodb', 'invites', 'Collection.find'] }],
      runs: [{ test: 'c', layer: 'component', units: ['getInvites', 'mapped'], links: [] }],
      changed: ['getInvites', 'mapped'],
    }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
  });

  it('holds a function written inside one that only reaches the outside service through a helper to a unit test', () => {
    const judged = judge(codebase({
      units: [
        { id: 'wiring', file: 'worker.ts', name: 'buildActivities', line: 1 },
        { id: 'connect', file: 'worker.ts', name: 'connect', line: 9 },
        { id: 'activity', file: 'worker.ts', name: 'activity', line: 2, within: 'wiring' },
      ],
      links: [
        { id: 'worker.ts:3', from: 'wiring', to: ['connect'], kind: 'logic' },
        { id: 'worker.ts:10', from: 'connect', to: ['pkg:@temporalio/client#Connection.connect'], kind: 'dependency', path: ['@temporalio/client', 'Connection.connect'] },
      ],
      runs: [{ test: 'v', layer: 'vm', units: ['wiring', 'connect', 'activity'], links: [] }],
      changed: ['activity'],
    }), WEIGHTS);

    expect(judged.blocking.map((unit) => unit.id)).toEqual(['activity']);
  });

  it('holds a caller in another file that reaches the service only through the adapter to a unit test', () => {
    const judged = judge(codebase({
      units: [
        { id: 'service', file: 'service.ts', name: 'Service.invite', line: 1 },
        { id: 'byHash', file: 'store.ts', name: 'Store.getInviteByHash', line: 5 },
      ],
      links: [
        { id: 'service.ts:2', from: 'service', to: ['byHash'], kind: 'logic' },
        { id: 'store.ts:6', from: 'byHash', to: ['pkg:mongodb#Collection.findOne'], kind: 'dependency', path: ['mongodb', 'invites', 'Collection.findOne'] },
      ],
      runs: [{ test: 'c', layer: 'component', units: ['service', 'byHash'], links: [] }],
      changed: ['service'],
    }), WEIGHTS);

    expect(judged.blocking.map((unit) => unit.id)).toEqual(['service']);
  });

  it('holds a unit whose only calls are into Koala\'s own pieces to a unit test', () => {
    const judged = judge(codebase({
      links: [{ id: 'a.ts:2', from: 'save', to: ['store'], kind: 'composition' }, { id: 'b.ts:2', from: 'store', to: ['pkg:mongodb#insertOne'], kind: 'dependency', path: ['mongodb', 'users', 'insertOne'] }],
      runs: [{ test: 'c', layer: 'component', units: ['save', 'store'], links: [] }],
      changed: ['save'],
    }), WEIGHTS);

    expect(judged.blocking.map((unit) => unit.id)).toEqual(['save']);
  });

  it('leaves unchanged logic that only runs above unit unblocked', () => {
    const judged = judge(codebase({ runs: [{ test: 'c', layer: 'component', units: ['save', 'store', 'orphan'], links: [] }], changed: [] }), WEIGHTS);

    expect(judged.blocking).toEqual([]);
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
      'changed code the coupler refuses (blocks):',
      '  b.ts:1 store: no test runs it',
    ]);
  });
});

describe('a function\'s confidence from its own mutation score', () => {
  it('moves a function\'s confidence from what its layers give toward how many planted faults its own tests caught', () => {
    const judged = judge(codebase({
      runs: [{ test: 'u', layer: 'unit', units: ['save', 'store'], links: [] }],
      scores: { save: { caught: 2, missed: 18 }, store: { caught: 40, missed: 0 } },
    }), WEIGHTS);
    const of = (id: string) => judged.functions.find((one) => one.id === id)!;

    expect(of('save').confidence).toBeCloseTo((0.5 * 10 + 2) / (10 + 20));
    expect(of('store').confidence).toBeCloseTo((0.5 * 10 + 40) / (10 + 40));
    expect(of('save').scored).toEqual({ caught: 2, missed: 18 });
    expect(of('save').risk).toBeGreaterThan(of('store').risk);
  });

  it('leaves a function no mutation run judged at what its layers give, and says it was not scored', () => {
    const judged = judge(codebase({ runs: [{ test: 'u', layer: 'unit', units: ['save'], links: [] }] }), WEIGHTS);
    const save = judged.functions.find((one) => one.id === 'save')!;
    expect(save.confidence).toBeCloseTo(0.5);
    expect(save.scored).toBeUndefined();
  });
});

describe('the faults code already had', () => {
  it('weighs a function heavier for each real fault its file already had, so code that went wrong before ranks riskier', () => {
    const judged = judge(codebase({
      units: [{ id: 'calm', file: 'calm.ts', name: 'calm', line: 1 }, { id: 'burned', file: 'burned.ts', name: 'burned', line: 1 }],
      runs: [{ test: 'u', layer: 'unit', units: ['calm', 'burned'], links: [] }],
      history: { faults: { 'burned.ts': 2 } },
    }), WEIGHTS);
    const of = (id: string) => judged.functions.find((one) => one.id === id)!;

    expect(of('burned').risk).toBeCloseTo(of('calm').risk * 3);
    expect(judged.functions[0]!.id).toBe('burned');
  });
});

describe('functions whose tests let planted faults through', () => {
  it('lists the functions whose tests missed the most planted faults, with what was changed, after the riskiest functions', () => {
    const judged = judge(codebase({
      runs: [{ test: 'u', layer: 'unit', units: ['save', 'store', 'orphan'], links: [] }],
      unchecked: { store: { survived: 4, examples: ['line 3: EqualityOperator → a !== b'] }, save: { survived: 1, examples: ['line 9: BooleanLiteral → false'] } },
    }), WEIGHTS);

    expect(reportOf(judged, 2).split('\n').slice(-5)).toEqual([
      'tests let planted faults through:',
      '  4  b.ts:1 store',
      '       line 3: EqualityOperator → a !== b',
      '  1  a.ts:1 save',
      '       line 9: BooleanLiteral → false',
    ]);
  });
});

describe('the untested list, which only shrinks', () => {
  const unit = (file: string, name: string) => ({ id: `${file}:${name}`, file, name, line: 1 });

  it('names a function no test runs that the list does not hold as new, and one it held that is now run as fixed', () => {
    const held = heldTo([unit('a.ts', 'save'), unit('b.ts', 'load'), unit('b.ts', 'load')], { 'a.ts#save': 1, 'b.ts#load': 1, 'c.ts#gone': 1 });

    expect(held.added).toEqual(['b.ts#load']);
    expect(held.fixed).toEqual([{ key: 'c.ts#gone', was: 1, now: 0 }]);
  });

  it('holds nothing against a list that matches', () => {
    expect(heldTo([unit('a.ts', 'save')], { 'a.ts#save': 1 })).toEqual({ added: [], fixed: [] });
  });

  it('writes the list from today\'s untested functions, counting a name that occurs twice in a file', () => {
    expect(untestedList([unit('a.ts', 'save'), unit('a.ts', '(anonymous)'), unit('a.ts', '(anonymous)')])).toEqual({ 'a.ts#(anonymous)': 2, 'a.ts#save': 1 });
  });
});

describe('weights learned from evidence', () => {
  const PRIOR: Weights = { unit: 0.5, component: 0.6, contract: 0.7, container: 0.8, vm: 0.9 };

  it('keeps the starting weight while there is no evidence', () => {
    expect(learnedWeights(PRIOR, [], { strength: 10 }).weights).toEqual(PRIOR);
  });

  it('moves a layer\'s weight toward how often its tests caught a planted fault, more as evidence piles up', () => {
    const missed = (count: number) => Array.from({ length: count }, () => ({ layer: 'unit' as const, caught: false }));
    const caught = (count: number) => Array.from({ length: count }, () => ({ layer: 'unit' as const, caught: true }));

    const few = learnedWeights(PRIOR, [...caught(1), ...missed(9)], { strength: 10 }).weights.unit;
    const many = learnedWeights(PRIOR, [...caught(10), ...missed(90)], { strength: 10 }).weights.unit;

    expect(few).toBeCloseTo((5 + 1) / 20);
    expect(many).toBeCloseTo((5 + 10) / 110);
    expect(many).toBeLessThan(few);
    expect(learnedWeights(PRIOR, missed(5), { strength: 10 }).weights.vm).toBe(0.9);
  });

  it('counts older evidence for less, so the weight follows the tests as they change', () => {
    const old = Array.from({ length: 20 }, () => ({ layer: 'unit' as const, caught: false, age: 4 }));
    const recent = Array.from({ length: 20 }, () => ({ layer: 'unit' as const, caught: true, age: 0 }));

    expect(learnedWeights(PRIOR, [...old, ...recent], { strength: 10, halfLife: 1 }).weights.unit).toBeCloseTo(25 / 31.25);
  });

  it('says how much evidence each weight rests on', () => {
    const learned = learnedWeights(PRIOR, [{ layer: 'unit', caught: true }, { layer: 'unit', caught: false }], { strength: 10 });
    expect(learned.evidence.unit).toEqual({ caught: 1, missed: 1 });
    expect(learned.evidence.vm).toEqual({ caught: 0, missed: 0 });
  });
});
