import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildGraph, isTest, type Graph } from './graph.js';
import { areaOf } from './workspaces.js';

const ROOT = join(import.meta.dirname, 'fixture');

const fixture = (withinFiles = false): Graph => buildGraph({ projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true }], root: ROOT, calledFrom: (file) => !isTest(file), withinFiles });

const named = (graph: Graph, ids: readonly string[]): string[] => ids.map((id) => `${graph.units[id]!.file}#${graph.units[id]!.name}`).sort();
const callsAt = (graph: Graph, file: string, text: string) => {
  const source = graph.edges.filter((edge) => edge.site.file === file);
  return source.find((edge) => graph.units[edge.from] && named(graph, edge.to).some((name) => name.includes(text)));
};

describe('the edge graph', () => {
  const graph = fixture();

  it('takes a class handed in where an interface it never names is wanted as that interface\'s implementation', () => {
    const read = graph.edges.find((edge) => edge.site.file === 'src/reader/reader.ts' && edge.through === 'interface' && named(graph, edge.to).some((name) => name.endsWith('#PlainStore.read')));
    expect(read && named(graph, read.to)).toEqual(['src/store/plain.ts#PlainStore.read']);
  });

  it('follows a function handed to a callable interface, as an object\'s property or as an argument', () => {
    expect(callsAt(graph, 'src/reader/reader.ts', '#shout')?.through).toBe('interface');
    expect(callsAt(graph, 'src/reader/reader.ts', '#quiet')?.through).toBe('interface');
  });

  it('follows a call through a function type to each function given that type, a map of handlers called by name included', () => {
    const called = graph.edges.find((edge) => edge.site.file === 'src/handlers/registry.ts' && edge.through === 'interface');
    expect(called && named(graph, called.to).map((name) => name.split('#')[0])).toEqual(['src/handlers/greetings.ts', 'src/handlers/greetings.ts']);
    expect(called && named(graph, called.to).some((name) => name.includes('farewell'))).toBe(true);
  });

  it('does not follow a callback typed inline in a parameter to every function anyone hands it, which would join every caller\'s flow', () => {
    const inAround = graph.edges.filter((edge) => edge.site.file === 'src/handlers/registry.ts' && edge.through === 'interface' && named(graph, edge.to).some((name) => name.includes('measured')));
    expect(inAround).toEqual([]);
  });

  it('takes the function given after ?? for an optional one, so a clock nobody passes outside tests still has its implementation', () => {
    const inFile = fixture(true);
    const called = inFile.edges.find((edge) => edge.site.file === 'src/handlers/registry.ts' && edge.through === 'interface' && edge.site.line === 19);
    expect(called && named(inFile, called.to)).toEqual(['src/handlers/registry.ts#(anonymous)']);
  });

  it('follows a function handed over by a name destructured from, or read off, an object to what that object\'s member was given', () => {
    const called = graph.edges.find((edge) => edge.site.file === 'src/handlers/consumer.ts' && edge.through === 'interface');
    expect(called && named(graph, called.to)).toContain('src/handlers/core.ts#lookup');
  });

  it('follows a function a factory returns to the factory\'s own function, though the factory names only its type', () => {
    const called = graph.edges.find((edge) => edge.site.file === 'src/handlers/consumer.ts' && edge.through === 'interface');
    expect(called && named(graph, called.to)).toContain('src/handlers/factory.ts#(anonymous)');
  });

  it('takes a Promise\'s own resolve, kept and called later, as implemented outside our code rather than by nothing', () => {
    expect(graph.edges.filter((edge) => edge.site.file === 'src/handlers/waiting.ts' && edge.through === 'interface' && edge.to.length === 0)).toEqual([]);
  });

  it('follows a function stored into an object from a parameter to what the callers pass for that parameter', () => {
    const called = graph.edges.find((edge) => edge.site.file === 'src/handlers/stored.ts' && edge.through === 'interface');
    expect(called && named(graph, called.to)).toEqual(['src/handlers/token-wiring.ts#realToken']);
  });

  it('leaves a call whose only implementations are in tests without an edge, since production never makes it, and still names a call nothing implements', () => {
    const at = (line: number) => graph.edges.filter((edge) => edge.site.file === 'src/handlers/clocked.ts' && edge.site.line === line && edge.through === 'interface');
    expect(at(7)).toEqual([]);
    expect(at(11).map((edge) => edge.to)).toEqual([[]]);
  });

  it('never counts a fake from a test file, nor a class no one hands in', () => {
    const into = graph.edges.filter((edge) => edge.site.file === 'src/reader/reader.ts').flatMap((edge) => named(graph, edge.to));
    expect(into.some((name) => name.includes('reader.test.ts'))).toBe(false);
    expect(into).not.toContain('src/store/store.ts#MemoryStore.read');
  });

  it('records plain calls across files and leaves calls inside one file out', () => {
    expect(callsAt(graph, 'src/wiring.ts', '#readOne')?.through).toBe('call');
    expect(graph.edges.every((edge) => edge.to.every((id) => graph.units[id]!.file !== graph.units[edge.from]!.file))).toBe(true);
  });

  it('follows a callback handed in on an options object to what was handed, whether the property is optional or not', () => {
    const into = graph.edges.filter((edge) => graph.units[edge.from]?.name === 'finish').map((edge) => ({ through: edge.through, to: named(graph, edge.to) }));
    expect(into).toEqual(expect.arrayContaining([
      { through: 'interface', to: ['src/lib/shout.ts#shout'] },
      { through: 'interface', to: ['src/wiring.ts#onLoud'] },
    ]));
  });

  it('records calls inside one file only when asked for them', () => {
    const local = (built: Graph) => built.edges.filter((edge) => built.units[edge.from]?.name === 'finish').flatMap((edge) => named(built, edge.to)).filter((name) => name === 'src/reader/hooks.ts#local');
    expect(local(graph)).toEqual([]);
    expect(local(fixture(true))).toEqual(['src/reader/hooks.ts#local']);
  });

  it('takes what an async function returns as an implementation of the interface it promises', () => {
    const start = graph.edges.find((edge) => edge.site.file === 'src/wiring.ts' && edge.through === 'interface' && named(graph, edge.to).some((name) => name.startsWith('src/lib/made.ts')));
    expect(start && named(graph, start.to)).toEqual(['src/lib/made.ts#start']);
  });

  it('never takes a library\'s own declaration as what implements an interface, and leaves out a call only a library implements', () => {
    expect(Object.values(graph.units).some((unit) => unit.file.includes('node_modules') || unit.file.endsWith('.d.ts'))).toBe(false);
    expect(graph.edges.filter((edge) => edge.site.file === 'src/wiring.ts' && edge.to.length === 0)).toEqual([]);
  });

  it('keeps a call whose result another call is chained on', () => {
    const loud = graph.edges.find((edge) => graph.units[edge.from]?.name === 'loud');
    expect(loud && named(graph, loud.to)).toEqual(['src/lib/shout.ts#shout']);
  });

  it('reports a call through any as unresolved', () => {
    expect(graph.unresolved.map((call) => `${call.site.file} ${call.text} ${call.why}`)).toEqual(['src/reader/loose.ts thing.go called through any']);
  });

  it('scans no test file for calls', () => {
    expect(graph.edges.some((edge) => isTest(edge.site.file))).toBe(false);
  });
});

describe('what is a test and which area a file is in', () => {
  it('knows tests, test folders and test support by name', () => {
    expect(['a/b.test.ts', 'tests/lib/x.ts', 'apps/frontend/src/test/setup.ts', 'packages/agent-engine/testing/model.ts', 'src/platform/lib/test-database.ts', 'src/infrastructure/services/dns/fake-dns.ts'].filter(isTest)).toHaveLength(6);
    expect(['src/platform/lib/testing-levels.ts', 'src/accounts/lib/contest.ts', 'src/instances/lib/latest.ts'].filter(isTest)).toEqual([]);
  });

  it('names backend and frontend areas, apps and packages', () => {
    expect([
      'apps/backend/src/instances/lib/pool.ts', 'apps/backend/src/index.ts', 'apps/frontend/src/features/hub/api.ts',
      'apps/frontend/src/shell/router.tsx', 'apps/local-agent/src/agent.ts', 'packages/engine-core/src/payloads.ts', 'tests/coupling/graph.ts',
    ].map(areaOf)).toEqual(['backend/instances', 'backend', 'frontend/hub', 'frontend/shell', 'apps/local-agent', 'packages/engine-core', 'tests']);
  });
});

describe('hand-offs: a component rendered, a function handed over as a value', () => {
  const SCREENS = join(import.meta.dirname, 'fixture-screens');
  const screens = (handOffs: boolean): Graph => buildGraph({ projects: [{ tsconfig: join(SCREENS, 'tsconfig.json'), owns: () => true }], root: SCREENS, calledFrom: (file) => !isTest(file), handOffs });
  const kinds = (graph: Graph, through: string): string[] => graph.edges.filter((edge) => edge.through === through)
    .map((edge) => `${graph.units[edge.from]!.name} -> ${named(graph, edge.to).join(',')}`).sort();

  it('records neither unless asked, so the coupling audit judges the graph it always has', () => {
    const plain = screens(false);
    expect(kinds(plain, 'render')).toEqual([]);
    expect(kinds(plain, 'reference')).toEqual([]);
  });

  it('follows a component to each of our own components it renders, and not to an HTML element', () => {
    expect(kinds(screens(true), 'render')).toEqual(['Board -> src/Panel.tsx#Panel', 'Section -> src/Wizard.tsx#Wizard']);
  });

  it('takes a function handed to a component as a prop for what calls that prop, so the call is never left with no implementation', () => {
    const graph = screens(false);
    const called = graph.edges.find((edge) => edge.site.file === 'src/Panel.tsx' && edge.through === 'interface');
    expect(called && named(graph, called.to)).toEqual(['src/Board.tsx#(anonymous)']);
  });

  it('follows a function handed over to be called later, but not one called, imported or named only as a type', () => {
    const graph = screens(true);
    expect(kinds(graph, 'reference')).toEqual(['Panel -> src/Panel.tsx#done', 'useApps -> src/api.ts#getApps']);
    expect(kinds(graph, 'call')).toEqual(expect.arrayContaining(['useDelete -> src/api.ts#deleteApp', 'Section -> src/hooks.ts#useApps']));
  });
});

describe('calls between workspaces linked as npm links them', () => {
  const root = mkdtempSync(join(tmpdir(), 'graph-workspaces-'));
  cpSync(join(import.meta.dirname, 'fixture-graph-workspaces'), root, { recursive: true });
  mkdirSync(join(root, 'apps/app/node_modules/@fixture'), { recursive: true });
  symlinkSync('../../../../packages/runner', join(root, 'apps/app/node_modules/@fixture/runner'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('follows a package\'s call through a function type to the handlers an app gives it, the app read before the package', () => {
    const graph = buildGraph({
      projects: [
        { tsconfig: join(root, 'apps/app/tsconfig.json'), owns: (file) => file.startsWith('apps/') },
        { tsconfig: join(root, 'packages/runner/tsconfig.json'), owns: (file) => file.startsWith('packages/') },
      ],
      root, calledFrom: () => true,
    });
    const called = graph.edges.find((edge) => edge.site.file === 'packages/runner/src/run.ts' && edge.through === 'interface');
    expect(called && named(graph, called.to)).toEqual(['apps/app/src/handlers.ts#greet']);
  });
});
