import type { Artifact, Gathered } from './artifacts.js';
import type { Graph, Unresolved } from './graph.js';
import type { Judged, Level } from './join.js';
import { byArea, type AreaCount } from './report.js';
import { crossesProcess, type Against, type Breach, type Judging } from './rules.js';

export interface ResultEdge {
  from: string;
  site: string;
  to: string[];
  through: string;
  crosses: 'area' | 'process' | 'none';
  lowest?: Level | undefined;
  withCallerAt?: Level | undefined;
  tests: number;
}

export interface Result {
  version: 1;
  at: string;
  commit: string;
  source: string;
  gathered: Partial<Record<Artifact, Gathered>>;
  problems: string[];
  rules: Judging;
  seconds: { graph: number; join: number };
  totals: { edges: number; betweenAreas: number; betweenProcesses: number; covered: number; noImplementation: number; unresolved: number };
  areas: AreaCount[];
  breaches: Breach[];
  baseline: { kind: 'held'; added: Breach[]; fixed: Against['fixed'] } | { kind: 'seeded'; count: number } | { kind: 'none' };
  unresolved: Unresolved[];
  edges: ResultEdge[];
}

export function resultOf(input: Omit<Result, 'version' | 'totals' | 'areas' | 'edges' | 'unresolved'> & { judged: readonly Judged[]; graph: Graph }): Result {
  const { judged, graph, ...rest } = input;
  const name = (id: string) => { const unit = graph.units[id]; return unit ? `${unit.file}#${unit.name}` : id; };
  const edges = judged.map((entry): ResultEdge => ({
    from: name(entry.edge.from),
    site: `${entry.edge.site.file}:${entry.edge.site.line}`,
    to: entry.edge.to.map(name),
    through: entry.edge.through,
    crosses: crossesProcess(entry.edge) ? 'process' : entry.crosses,
    lowest: entry.lowest,
    withCallerAt: entry.withCallerAt,
    tests: entry.covered.length,
  }));
  return {
    version: 1,
    ...rest,
    totals: {
      edges: edges.length,
      betweenAreas: edges.filter((edge) => edge.crosses === 'area').length,
      betweenProcesses: edges.filter((edge) => edge.crosses === 'process').length,
      covered: edges.filter((edge) => edge.tests > 0).length,
      noImplementation: edges.filter((edge) => edge.to.length === 0).length,
      unresolved: graph.unresolved.length,
    },
    areas: byArea(judged, graph),
    unresolved: graph.unresolved,
    edges,
  };
}
