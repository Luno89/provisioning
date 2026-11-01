import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest, type Graph } from './graph.js';
import { areaOf } from './workspaces.js';

const ROOT = join(import.meta.dirname, 'fixture');

const fixture = (): Graph => buildGraph({ projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true }], root: ROOT, calledFrom: (file) => !isTest(file) });

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

  it('never counts a fake from a test file, nor a class no one hands in', () => {
    const into = graph.edges.filter((edge) => edge.site.file === 'src/reader/reader.ts').flatMap((edge) => named(graph, edge.to));
    expect(into.some((name) => name.includes('reader.test.ts'))).toBe(false);
    expect(into).not.toContain('src/store/store.ts#MemoryStore.read');
  });

  it('records plain calls across files and leaves calls inside one file out', () => {
    expect(callsAt(graph, 'src/wiring.ts', '#readOne')?.through).toBe('call');
    expect(graph.edges.every((edge) => edge.to.every((id) => graph.units[id]!.file !== graph.units[edge.from]!.file))).toBe(true);
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
