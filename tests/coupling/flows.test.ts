import { describe, expect, it } from 'vitest';
import type { Concept } from './concepts.js';
import type { Edge, Graph, Unit } from './graph.js';
import { byFile, conceptIndex, enclosingUnits, flowDiff, flowFrom, mermaidOf, snapshotOf, touchesIn, type FlowSpec, type Snapshot } from './flows.js';
import { UNNAMED } from './record-access.js';

const SOURCES: Record<string, string> = {
  'apps/frontend/src/features/x/api.ts': 'export const go = () => post("/go");\n',
  'apps/backend/src/x/routes/go.ts': 'router.post("/go", () => start());\n',
  'apps/backend/src/x/services/Start.ts': 'function start() {\n  const config = process.env.DEPTH;\n  return reach();\n}\nfunction helper() { return 1; }\n',
  'apps/backend/src/x/services/Reach.ts': 'function reach() {\n  run(["kubectl", "get"], "/tmp/kubeconfig-x");\n  const inner = () => run(["helm", "list"]);\n  return inner();\n}\n',
  'apps/backend/src/x/services/Idle.ts': 'function idle() { return 2; }\n',
  'apps/backend/src/x/services/Lost.ts': 'function lost() { return workflows.start(name); }\n',
  'apps/backend/src/x/store.ts': 'function save() {}\n',
  'apps/backend/src/x/Reach.test.ts': 'it("x", () => run(["kubectl"]));\n',
};

const spanOf = (file: string, from: string, to?: string): { start: number; end: number } => {
  const text = SOURCES[file]!;
  const start = text.indexOf(from);
  return { start, end: to ? text.indexOf(to, start) + to.length : text.length };
};

const unit = (file: string, name: string, line: number, from: string, to?: string, inTest = false): Unit =>
  ({ id: `${file}:${line}:1`, file, name, line, column: 1, ...spanOf(file, from, to), inTest });

const UNITS = [
  unit('apps/frontend/src/features/x/api.ts', 'go', 1, 'export'),
  unit('apps/backend/src/x/routes/go.ts', '(anonymous)', 1, '() =>'),
  unit('apps/backend/src/x/services/Start.ts', 'start', 1, 'function start', '}\n'),
  unit('apps/backend/src/x/services/Start.ts', 'helper', 5, 'function helper'),
  unit('apps/backend/src/x/services/Reach.ts', 'reach', 1, 'function reach'),
  unit('apps/backend/src/x/services/Reach.ts', 'inner', 3, '() => run(["helm"', ');'),
  unit('apps/backend/src/x/services/Idle.ts', 'idle', 1, 'function idle'),
  unit('apps/backend/src/x/services/Lost.ts', 'lost', 1, 'function lost'),
  unit('apps/backend/src/x/store.ts', 'save', 1, 'function save'),
  unit('apps/backend/src/x/Reach.test.ts', '(anonymous)', 1, '() =>', undefined, true),
];

const id = (file: string, name: string): string => UNITS.find((entry) => entry.file === file && entry.name === name)!.id;
const GO = id('apps/frontend/src/features/x/api.ts', 'go');
const ROUTE = id('apps/backend/src/x/routes/go.ts', '(anonymous)');
const START = id('apps/backend/src/x/services/Start.ts', 'start');
const REACH = id('apps/backend/src/x/services/Reach.ts', 'reach');
const INNER = id('apps/backend/src/x/services/Reach.ts', 'inner');
const IDLE = id('apps/backend/src/x/services/Idle.ts', 'idle');
const LOST = id('apps/backend/src/x/services/Lost.ts', 'lost');
const SAVE = id('apps/backend/src/x/store.ts', 'save');
const TEST = id('apps/backend/src/x/Reach.test.ts', '(anonymous)');

const edge = (from: string, to: string[], through: Edge['through'], line = 1): Edge =>
  ({ from, to, through, site: { file: UNITS.find((entry) => entry.id === from)!.file, line, column: 1, start: 0, end: 0 } });

const graphWith = (edges: Edge[]): Graph => ({ units: Object.fromEntries(UNITS.map((entry) => [entry.id, entry])), edges, unresolved: [], unmatched: [], records: [] });

const GRAPH = graphWith([
  edge(GO, [ROUTE], 'http'),
  edge(ROUTE, [START], 'call'),
  edge(ROUTE, [IDLE], 'call'),
  edge(ROUTE, [LOST], 'call'),
  edge(START, [REACH], 'call', 3),
  edge(START, [SAVE], 'interface'),
  edge(LOST, [], 'temporal'),
  edge(TEST, [REACH], 'call'),
]);

const CONCEPTS: Concept[] = [
  { id: 'kubeconfig', label: 'obtains a kubeconfig', marks: [/\/tmp\/kubeconfig/] },
  { id: 'cluster-command', label: 'uses kubectl or helm', marks: [/['"]kubectl\b/, /['"]helm\b/] },
  { id: 'config', label: 'reads configuration', marks: [/\bprocess\.env\b/] },
  { id: 'store', label: 'reads or writes stored records', inFile: /(^|\/)store\.ts$/ },
  { id: 'work', label: 'hands work on', through: ['temporal'] },
];

const touches = touchesIn(GRAPH, (file) => SOURCES[file], CONCEPTS);
const SPEC: FlowSpec = { name: 'go', title: 'Go', entries: ['apps/frontend/src/features/x/api.ts#go'], concepts: ['kubeconfig', 'cluster-command'] };

describe('where code touches the outside world', () => {
  it('charges a mark to the innermost function whose own code holds it, never to a test', () => {
    expect(touches.map((touch) => `${touch.concept} ${touch.unit} ${touch.line}`)).toEqual([
      `config ${START} 2`,
      `cluster-command ${REACH} 2`,
      `kubeconfig ${REACH} 2`,
      `cluster-command ${INNER} 3`,
      `work ${LOST} 1`,
      `store ${SAVE} 1`,
    ].sort((a, b) => a.split(' ')[1]!.localeCompare(b.split(' ')[1]!) || a.split(' ')[0]!.localeCompare(b.split(' ')[0]!)));
  });

  it('knows which function each nested function sits in', () => {
    expect(enclosingUnits(GRAPH).get(INNER)).toBe(REACH);
    expect(enclosingUnits(GRAPH).has(REACH)).toBe(false);
  });
});

describe('a flow from where the browser starts it', () => {
  const flow = flowFrom(GRAPH, SPEC, touches);

  it('keeps only the paths that reach the concepts asked for, nested functions included', () => {
    expect(flow.units).toEqual([GO, ROUTE, START, REACH, INNER, LOST].sort());
    expect(flow.units).not.toContain(IDLE);
    expect(flow.units).not.toContain(SAVE);
    expect(flow.links).toEqual(expect.arrayContaining([{ from: REACH, to: INNER, through: 'within' }, { from: GO, to: ROUTE, through: 'http' }]));
  });

  it('keeps where the trail is lost, so a map never stops silently', () => {
    expect(flow.gaps).toEqual([{ unit: LOST, at: 'apps/backend/src/x/services/Lost.ts:1', through: 'temporal' }]);
  });

  it('says which entries it could not find', () => {
    expect(flowFrom(GRAPH, { ...SPEC, entries: ['apps/frontend/src/features/x/api.ts#gone'] }, touches)).toMatchObject({ missing: ['apps/frontend/src/features/x/api.ts#gone'], units: [] });
  });

  it('folds into files, with the concepts each touches, where it starts and where it stops', () => {
    const files = byFile(GRAPH, flow);
    expect(files.files.map((node) => [node.file, node.entry, node.concepts, node.gaps])).toEqual([
      ['apps/backend/src/x/routes/go.ts', false, [], []],
      ['apps/backend/src/x/services/Lost.ts', false, [], ['apps/backend/src/x/services/Lost.ts:1 (temporal)']],
      ['apps/backend/src/x/services/Reach.ts', false, ['cluster-command', 'kubeconfig'], []],
      ['apps/backend/src/x/services/Start.ts', false, [], []],
      ['apps/frontend/src/features/x/api.ts', true, [], []],
    ]);
    expect(files.links).toContainEqual({ from: 'apps/frontend/src/features/x/api.ts', to: 'apps/backend/src/x/routes/go.ts', through: ['http'] });
    expect(files.links.some((link) => link.from === link.to)).toBe(false);
  });

  it('draws it with every box named by area and file, quotes escaped', () => {
    const drawn = mermaidOf(byFile(GRAPH, flow), { kubeconfig: 'obtains "a" kubeconfig' });
    expect(drawn).toContain('backend/x<br/>Reach.ts<br/><i>cluster-command, obtains #quot;a#quot; kubeconfig</i>');
    expect(drawn).toContain(':::entry');
    expect(drawn).toContain('map stops here');
    expect(drawn).toContain('-->|http|');
  });
});

describe('how a flow ends', () => {
  const written = (unit: string, collection: string, writes: boolean) => ({ unit, collection, writes, site: { file: UNITS.find((entry) => entry.id === unit)!.file, line: 1, column: 1, start: 0, end: 0 } });
  const recorded = (records: Graph['records'], edges = GRAPH.edges): Graph => ({ ...graphWith(edges), records });
  const ending = (title: string, entry: string) => ({ title, entries: [entry] });
  const IDLE_ENTRY = 'apps/backend/src/x/services/Idle.ts#idle';

  it('meets the flow at a record the flow writes and the ending reads', () => {
    const graph = recorded([written(SAVE, 'things', true), written(IDLE, 'things', false)]);
    expect(flowFrom(graph, { ...SPEC, endings: [ending('Shown', IDLE_ENTRY)] }, touches).endings).toMatchObject([{ title: 'Shown', missing: [], meets: ['record things'] }]);
  });

  it('meets it nowhere when the ending reads only what the flow never writes, or a collection named at run time', () => {
    const graph = recorded([written(SAVE, 'things', true), written(SAVE, UNNAMED, true), written(IDLE, 'other', false), written(IDLE, UNNAMED, false)]);
    expect(flowFrom(graph, { ...SPEC, endings: [ending('Shown', IDLE_ENTRY)] }, touches).endings[0]!.meets).toEqual([]);
  });

  it('meets it at a socket event the flow sends and the ending hears', () => {
    const graph = recorded([], [...GRAPH.edges, edge(START, [IDLE], 'socket', 2)]);
    expect(flowFrom(graph, { ...SPEC, endings: [ending('Heard', IDLE_ENTRY)] }, touches).endings[0]!.meets).toEqual(['socket apps/backend/src/x/services/Start.ts#start -> apps/backend/src/x/services/Idle.ts#idle']);
  });

  it('says which ending entries it could not find, and puts the endings in the snapshot and its diff', () => {
    const graph = recorded([written(SAVE, 'things', true), written(IDLE, 'things', false)]);
    const flow = flowFrom(graph, { ...SPEC, endings: [ending('Shown', IDLE_ENTRY), ending('Lost', 'apps/backend/src/x/services/Gone.ts#gone')] }, touches);
    expect(flow.endings[1]).toMatchObject({ missing: ['apps/backend/src/x/services/Gone.ts#gone'], meets: [] });
    const after = snapshotOf(graph, 'c', [flow], {});
    expect(after.flows.go!.endings).toEqual([
      { title: 'Shown', missing: [], files: ['apps/backend/src/x/services/Idle.ts'], meets: ['record things'] },
      { title: 'Lost', missing: ['apps/backend/src/x/services/Gone.ts#gone'], files: [], meets: [] },
    ]);
    const before = snapshotOf(graph, 'c', [flowFrom(recorded([]), { ...SPEC, endings: [ending('Shown', IDLE_ENTRY)] }, touches)], {});
    expect(flowDiff(before, after).map((change) => `${change.where} ${change.kind} ${change.what}`)).toEqual(expect.arrayContaining([
      'flow go, how it ends added Shown: meets at record things',
      'flow go, how it ends removed Shown: meets the flow nowhere',
    ]));
  });
});

describe('every implementation of a concept', () => {
  it('lists each function whose own code does it, with how many functions outside tests call it', () => {
    expect(conceptIndex(GRAPH, touches, 'cluster-command')).toEqual([
      { unit: 'apps/backend/src/x/services/Reach.ts#reach', file: 'apps/backend/src/x/services/Reach.ts', line: 2, callers: 1 },
      { unit: 'apps/backend/src/x/services/Reach.ts#inner', file: 'apps/backend/src/x/services/Reach.ts', line: 3, callers: 0 },
    ]);
  });
});

describe('what a change did to the flows', () => {
  const snapshot = (graph: Graph): Snapshot => {
    const found = touchesIn(graph, (file) => SOURCES[file], CONCEPTS);
    return snapshotOf(graph, 'c', [flowFrom(graph, SPEC, found)], { 'cluster-command': conceptIndex(graph, found, 'cluster-command') });
  };

  it('names nothing when nothing changed', () => {
    expect(flowDiff(snapshot(GRAPH), snapshot(GRAPH))).toEqual([]);
  });

  it('names a path, a touch and where the map stops, added or removed', () => {
    const before = snapshot(GRAPH);
    const after = snapshot(graphWith([...GRAPH.edges.filter((entry) => entry.from !== ROUTE || !entry.to.includes(LOST)), edge(ROUTE, [IDLE], 'call'), edge(IDLE, [REACH], 'call')]));
    const changes = flowDiff(before, after).map((change) => `${change.where} ${change.kind} ${change.what}`);
    expect(changes).toContain('flow go added apps/backend/src/x/services/Idle.ts -> apps/backend/src/x/services/Reach.ts');
    expect(changes).toContain('flow go removed apps/backend/src/x/routes/go.ts -> apps/backend/src/x/services/Lost.ts');
    expect(changes).toContain('flow go, where the map stops removed temporal apps/backend/src/x/services/Lost.ts:1');
  });
});
