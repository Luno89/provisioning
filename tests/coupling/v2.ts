import type { Codebase, Kind, Layer, Link, Run } from '@koala/coupling';
import type { Ran } from './collect.js';
import type { Edge, Graph, Unit } from './graph.js';
import { judge, siteRan, unitsRanBy } from './join.js';
import { crossesProcess } from './rules.js';
import { areaOf } from './workspaces.js';

export const DEPENDENCIES: Readonly<Record<string, Layer>> = {
  mongodb: 'component',
  '@temporalio/client': 'component',
  '@temporalio/worker': 'component',
  '@temporalio/activity': 'component',
  'node:child_process': 'component',
  minio: 'container',
  nodemailer: 'container',
  'web-push': 'container',
  'openid-client': 'container',
  'oidc-provider': 'container',
};

export const layerOf = (testFile: string): Layer =>
  /-live\.ts$/.test(testFile) ? 'vm' : /\.integration\.test\.[a-z]+$/.test(testFile) ? 'component' : 'unit';

const judged = (unit: Unit): boolean => !unit.inTest && !unit.noBehaviour && unit.name !== '(module)';

function kindOf(edge: Edge, graph: Graph): Kind {
  if (edge.through === 'dependency') return 'dependency';
  if (crossesProcess(edge)) return 'composition';
  const from = graph.units[edge.from];
  const crosses = from !== undefined && edge.to.some((id) => graph.units[id] !== undefined && areaOf(graph.units[id]!.file) !== areaOf(from.file));
  return crosses ? 'composition' : 'logic';
}

function linkIds(edges: readonly Edge[]): string[] {
  const short = edges.map((edge) => `${edge.site.file}:${edge.site.line}`);
  const seen = new Map<string, number>();
  for (const id of short) seen.set(id, (seen.get(id) ?? 0) + 1);
  return edges.map((edge, index) => (seen.get(short[index]!)! > 1 ? `${short[index]}:${edge.site.column}` : short[index]!));
}

export function codebaseOf(graph: Graph, ran: readonly Ran[], changedFiles: readonly string[]): Codebase {
  const units = Object.values(graph.units).filter(judged);
  const kept = new Set(units.map((unit) => unit.id));
  const ids = linkIds(graph.edges);
  const links: Link[] = graph.edges.map((edge, index): Link => {
    if (edge.through !== 'dependency') return { id: ids[index]!, from: edge.from, to: edge.to.filter((id) => kept.has(id)), kind: kindOf(edge, graph) };
    const realFrom = DEPENDENCIES[edge.path?.[0] ?? ''];
    return { id: ids[index]!, from: edge.from, to: edge.to, kind: 'dependency', ...(edge.path ? { path: edge.path } : {}), ...(realFrom ? { realFrom } : {}) };
  });
  const outward = graph.edges.map((edge, index) => ({ edge, id: ids[index]! })).filter(({ edge }) => edge.through === 'dependency');
  const provedBy = new Map<string, string[]>();
  judge(graph, ran, () => 'unit').forEach((entry, index) => {
    for (const covered of entry.covered) provedBy.set(covered.test, [...(provedBy.get(covered.test) ?? []), ids[index]!]);
  });
  const unitsBy = new Map<string, string[]>();
  for (const [unit, tests] of unitsRanBy(graph, ran)) {
    if (!kept.has(unit)) continue;
    for (const test of new Set(tests)) unitsBy.set(test, [...(unitsBy.get(test) ?? []), unit]);
  }
  const runs: Run[] = ran.map((run) => ({
    test: run.testFile,
    layer: layerOf(run.testFile),
    units: [...new Set(unitsBy.get(run.testFile) ?? [])].sort(),
    links: [...new Set([
      ...(provedBy.get(run.testFile) ?? []),
      ...outward.filter(({ edge }) => siteRan(run.files[edge.site.file], { line: edge.site.line, column: edge.site.column })).map(({ id }) => id),
    ])],
  }));
  const changed = new Set(changedFiles);
  return {
    units: units.map((unit) => ({ id: unit.id, file: unit.file, name: unit.name, line: unit.line })),
    links,
    runs,
    changed: units.filter((unit) => changed.has(unit.file)).map((unit) => unit.id).sort(),
  };
}
