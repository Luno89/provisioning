import type { Edge, Graph, Unit } from './graph.js';
import type { Position, Ran, RanRange } from './collect.js';

export type Level = 'unit' | 'component' | 'contract' | 'container' | 'live' | 'vm';
export const LEVELS: readonly Level[] = ['unit', 'component', 'contract', 'container', 'live', 'vm'];

export interface Covered { test: string; level: Level; withCaller: boolean }
export interface Judged { edge: Edge; crosses: 'area' | 'none'; covered: Covered[]; lowest?: Level | undefined; withCallerAt?: Level | undefined }

const before = (a: Position, b: Position): boolean => a.line < b.line || (a.line === b.line && a.column <= b.column);
const contains = (range: RanRange, at: Position): boolean => before(range.start, at) && before(at, range.end);
const size = (range: RanRange): number => (range.end.line - range.start.line) * 10_000 + (range.end.column - range.start.column);

export function areaOf(file: string): string {
  const parts = file.split('/');
  return parts[0] === 'src' && parts.length > 2 ? parts[1]! : parts.slice(0, 2).join('/');
}

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
  const intoUnit = new Map<string, Edge[]>();
  for (const edge of graph.edges) for (const to of edge.to) intoUnit.set(to, [...(intoUnit.get(to) ?? []), edge]);

  const coveredIn = (edge: Edge, run: Ran): boolean => {
    if (!siteRan(run.files[edge.site.file], { line: edge.site.line, column: edge.site.column })) return false;
    return edge.to.some((id) => {
      const unit = graph.units[id];
      return unit !== undefined && !unit.inTest && unitRan(run.files[unit.file], unit);
    });
  };

  return graph.edges.map((edge) => {
    const from = graph.units[edge.from];
    const crosses = from && edge.to.some((id) => graph.units[id] && areaOf(graph.units[id]!.file) !== areaOf(from.file)) ? 'area' : 'none';
    const covered: Covered[] = [];
    for (const run of runs) {
      if (!coveredIn(edge, run)) continue;
      const callers = intoUnit.get(edge.from) ?? [];
      covered.push({ test: run.testFile, level: levelOf(run.testFile), withCaller: callers.some((caller) => coveredIn(caller, run)) });
    }
    const rank = (level: Level) => LEVELS.indexOf(level);
    const lowest = covered.map((entry) => entry.level).sort((a, b) => rank(a) - rank(b))[0];
    const withCallerAt = covered.filter((entry) => entry.withCaller).map((entry) => entry.level).sort((a, b) => rank(a) - rank(b))[0];
    return { edge, crosses, covered, lowest, withCallerAt };
  });
}
