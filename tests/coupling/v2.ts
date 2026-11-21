import type { Codebase, Kind, Layer, Link, Run, Sharing } from '@koala/coupling';
import type { Ran, RanRange } from './collect.js';
import type { Edge, Graph, Unit } from './graph.js';
import { judge, siteRan, unitsRanBy } from './join.js';
import { STARTUP } from './live.js';
import { areaOf } from './workspaces.js';

const CROSS_PROCESS: ReadonlySet<Edge['through']> = new Set(['temporal', 'socket', 'http', 'env']);

export const crossesProcess = (edge: Edge): boolean => CROSS_PROCESS.has(edge.through);

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

export const SHARING: Sharing = { service: 0.6, resource: 0.2, operation: 0.2 };

export interface Since { files: string[]; versions: Record<string, string> }

export interface Context {
  changed: readonly string[];
  since?: (testFile: string) => Since | undefined;
  versions?: Record<string, string>;
  churn?: Record<string, number>;
  failures?: Record<string, number>;
}

export const layerOf = (testFile: string): Layer =>
  /-live\.ts$/.test(testFile) || testFile === STARTUP ? 'vm' : /\.integration\.test\.[a-z]+$/.test(testFile) ? 'component' : 'unit';

const REAL_THINGS = /(^|\/)testing\/(real-[^/]+|private-cluster|cluster-wide|root-services-world|containers?|temporal-test-env)\.ts$/;
const CONTRACTS = /(^|\/)testing\/[^/]*contract\.ts$/;

const ranAny = (run: Ran, matching: RegExp): boolean =>
  Object.entries(run.files).some(([file, ranges]) => matching.test(file) && ranges.some((range) => range.count > 0));

export function layerOfRun(run: Ran): Layer {
  const named = layerOf(run.testFile);
  if (named !== 'component') return named;
  if (ranAny(run, REAL_THINGS)) return 'container';
  return ranAny(run, CONTRACTS) ? 'contract' : 'component';
}

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
  const given = new Map<string, number>();
  return edges.map((edge, index) => {
    const id = seen.get(short[index]!)! > 1 ? `${short[index]}:${edge.site.column}` : short[index]!;
    const count = (given.get(id) ?? 0) + 1;
    given.set(id, count);
    return count === 1 ? id : `${id}#${count}`;
  });
}

const handlerRan = (ranges: readonly RanRange[] | undefined, handler: { line: number; endLine: number }): boolean =>
  (ranges ?? []).some((range) => range.count > 0 && range.start.line >= handler.line && range.end.line <= handler.endLine);

export function codebaseOf(graph: Graph, ran: readonly Ran[], context: Context): Codebase {
  const units = Object.values(graph.units).filter(judged);
  const kept = new Set(units.map((unit) => unit.id));
  const ids = linkIds(graph.edges);
  const links: Link[] = graph.edges.map((edge, index): Link => {
    if (edge.through !== 'dependency') return { id: ids[index]!, from: edge.from, to: edge.to.filter((id) => kept.has(id)), kind: kindOf(edge, graph) };
    const realFrom = DEPENDENCIES[edge.path?.[0] ?? ''];
    return { id: ids[index]!, from: edge.from, to: edge.to, kind: 'dependency', ...(edge.path ? { path: edge.path } : {}), ...(realFrom ? { realFrom } : {}) };
  });
  const outward = graph.edges.map((edge, index) => ({ edge, id: ids[index]! })).filter(({ edge }) => edge.through === 'dependency');
  const failing = outward.filter(({ edge }) => edge.handler !== undefined);
  for (const { edge, id } of failing) {
    const realFrom = DEPENDENCIES[edge.path?.[0] ?? ''];
    const [service = '', ...rest] = edge.path ?? [];
    links.push({ id: `${id}!fails`, from: edge.from, to: edge.to, kind: 'dependency', path: [`${service}!fails`, ...rest], ...(realFrom ? { realFrom } : {}) });
  }
  const provedBy = new Map<string, string[]>();
  judge(graph, ran, () => 'unit').forEach((entry, index) => {
    for (const covered of entry.covered) provedBy.set(covered.test, [...(provedBy.get(covered.test) ?? []), ids[index]!]);
  });
  const unitsBy = new Map<string, string[]>();
  for (const [unit, tests] of unitsRanBy(graph, ran)) {
    if (!kept.has(unit)) continue;
    for (const test of new Set(tests)) unitsBy.set(test, [...(unitsBy.get(test) ?? []), unit]);
  }
  const unitsIn = (files: readonly string[]): string[] => { const set = new Set(files); return units.filter((unit) => set.has(unit.file)).map((unit) => unit.id).sort(); };
  const runs: Run[] = ran.map((run): Run => {
    const since = context.since?.(run.testFile);
    return {
    test: run.testFile,
    layer: layerOfRun(run),
    units: [...new Set(unitsBy.get(run.testFile) ?? [])].sort(),
    links: [...new Set([
      ...(provedBy.get(run.testFile) ?? []),
      ...outward.filter(({ edge }) => siteRan(run.files[edge.site.file], { line: edge.site.line, column: edge.site.column })).map(({ id }) => id),
      ...failing.filter(({ edge }) => handlerRan(run.files[edge.site.file], edge.handler!)).map(({ id }) => `${id}!fails`),
    ])],
    ...(since ? { expired: unitsIn(since.files), versions: since.versions } : {}),
    };
  });
  const changes: Record<string, number> = {};
  for (const unit of units) if (context.churn?.[unit.file]) changes[unit.id] = context.churn[unit.file]!;
  const failures: Record<string, number> = {};
  for (const run of runs) {
    const failed = context.failures?.[run.test] ?? 0;
    if (failed > 0) for (const unit of run.units) failures[unit] = (failures[unit] ?? 0) + failed;
  }
  return {
    units: units.map((unit) => ({ id: unit.id, file: unit.file, name: unit.name, line: unit.line })),
    links,
    runs,
    changed: unitsIn(context.changed),
    ...(context.versions ? { versions: context.versions } : {}),
    ...(context.churn || context.failures ? { history: { changes, failures } } : {}),
  };
}

export function versionsIn(lock: string, modules: readonly string[]): Record<string, string> {
  const packages = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages ?? {};
  const found: Record<string, string> = {};
  for (const module of modules) {
    const version = packages[`node_modules/${module}`]?.version;
    if (version !== undefined) found[module] = version;
  }
  return found;
}
