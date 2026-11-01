import type { Edge, Graph, Unit } from './graph.js';
import type { Position, Ran, RanRange } from './collect.js';
import { areaOf } from './workspaces.js';

export type Level = 'unit' | 'component' | 'contract' | 'container' | 'live' | 'vm';
export const LEVELS: readonly Level[] = ['unit', 'component', 'contract', 'container', 'live', 'vm'];

export interface Covered { test: string; level: Level; withCaller: boolean }
export interface Judged { edge: Edge; crosses: 'area' | 'none'; covered: Covered[]; lowest?: Level | undefined; withCallerAt?: Level | undefined }

const before = (a: Position, b: Position): boolean => a.line < b.line || (a.line === b.line && a.column <= b.column);
const contains = (range: RanRange, at: Position): boolean => before(range.start, at) && before(at, range.end);
const size = (range: RanRange): number => (range.end.line - range.start.line) * 10_000 + (range.end.column - range.start.column);

function siteRan(ranges: readonly RanRange[] | undefined, at: Position): boolean {
  if (!ranges) return false;
  let innermost: RanRange | undefined;
  for (const range of ranges) if (contains(range, at) && (!innermost || size(range) <= size(innermost))) innermost = range;
  return (innermost?.count ?? 0) > 0;
}

function unitRan(ranges: readonly RanRange[] | undefined, unit: Unit): boolean {
  if (!ranges) return false;
  if (unit.name === '(module)') return ranges.some((range) => range.count > 0);
  const onLine = ranges.filter((range) => range.fn !== undefined && range.start.line === unit.line);
  if (onLine.length === 0) return false;
  const nearest = onLine.reduce((best, range) => (Math.abs(range.start.column - unit.column) < Math.abs(best.start.column - unit.column) ? range : best));
  return nearest.count > 0;
}

export function judge(graph: Graph, runs: readonly Ran[], levelOf: (testFile: string) => Level): Judged[] {
  const intoUnit = new Map<string, number[]>();
  const bySiteFile = new Map<string, number[]>();
  graph.edges.forEach((edge, index) => {
    for (const to of edge.to) intoUnit.set(to, [...(intoUnit.get(to) ?? []), index]);
    bySiteFile.set(edge.site.file, [...(bySiteFile.get(edge.site.file) ?? []), index]);
  });

  const coveredBy = graph.edges.map((): Covered[] => []);
  for (const run of runs) {
    const ran = new Set<number>();
    for (const file of Object.keys(run.files)) {
      for (const index of bySiteFile.get(file) ?? []) {
        const edge = graph.edges[index]!;
        if (!siteRan(run.files[file], { line: edge.site.line, column: edge.site.column })) continue;
        const real = edge.to.some((id) => {
          const unit: Unit | undefined = graph.units[id];
          return unit !== undefined && !unit.inTest && unitRan(run.files[unit.file], unit);
        });
        if (real) ran.add(index);
      }
    }
    const level = levelOf(run.testFile);
    for (const index of ran) {
      const callers = intoUnit.get(graph.edges[index]!.from) ?? [];
      coveredBy[index]!.push({ test: run.testFile, level, withCaller: callers.some((caller) => ran.has(caller)) });
    }
  }

  const rank = (level: Level) => LEVELS.indexOf(level);
  return graph.edges.map((edge: Edge, index) => {
    const from = graph.units[edge.from];
    const crosses = from && edge.to.some((id) => graph.units[id] && areaOf(graph.units[id]!.file) !== areaOf(from.file)) ? 'area' : 'none';
    const covered = coveredBy[index]!;
    const lowest = covered.map((entry) => entry.level).sort((a, b) => rank(a) - rank(b))[0];
    const withCallerAt = covered.filter((entry) => entry.withCaller).map((entry) => entry.level).sort((a, b) => rank(a) - rank(b))[0];
    return { edge, crosses, covered, lowest, withCallerAt };
  });
}
