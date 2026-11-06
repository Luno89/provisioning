import type { Graph } from '../coupling/graph.js';
import { byFile, flowFrom, type Gap, type Touch } from '../coupling/flows.js';
import { areaOf } from '../coupling/workspaces.js';
import type { Step } from './flow-spec.js';

export interface Crossing { through: string; from: string; to: string }

export interface StepTrace {
  step: string;
  starts: string[];
  notFound: string[];
  files: string[];
  areas: string[];
  crossings: Crossing[];
  concepts: Record<string, number>;
  gaps: Gap[];
}

const CROSSES: ReadonlySet<string> = new Set(['http', 'socket', 'temporal', 'env']);

export const CROSSES_ANOTHER_PROCESS = 'crosses-another-process';

const fileOf = (graph: Graph, unit: string): string => graph.units[unit]?.file ?? unit;

export function traceStep(graph: Graph, step: Step, concepts: readonly string[], touches: readonly Touch[]): StepTrace {
  const starts = step.code?.length ? step.code : step.screen.component ? [step.screen.component] : [];
  const crossingTouches = graph.edges.filter((edge) => CROSSES.has(edge.through))
    .flatMap((edge) => [edge.from, ...edge.to].map((unit) => ({ unit, concept: CROSSES_ANOTHER_PROCESS, line: edge.site.line })));
  const flow = flowFrom(graph, { name: step.id, title: step.does, entries: starts, concepts: [...concepts, CROSSES_ANOTHER_PROCESS] }, [...touches, ...crossingTouches]);
  const files = byFile(graph, flow).files.map((file) => file.file).sort();
  const crossings = flow.links.filter((link) => CROSSES.has(link.through))
    .map((link) => ({ through: link.through, from: fileOf(graph, link.from), to: fileOf(graph, link.to) }));
  const unique = [...new Map(crossings.map((crossing) => [`${crossing.through} ${crossing.from} ${crossing.to}`, crossing])).values()];
  const counted: Record<string, number> = {};
  for (const touch of flow.touches) if (touch.concept !== CROSSES_ANOTHER_PROCESS) counted[touch.concept] = (counted[touch.concept] ?? 0) + 1;
  return {
    step: step.id,
    starts,
    notFound: flow.missing,
    files,
    areas: [...new Set(files.map(areaOf))].sort(),
    crossings: unique,
    concepts: counted,
    gaps: flow.gaps,
  };
}
