import { basename } from 'node:path';
import type { Concept } from './concepts.js';
import type { Edge, Graph, Unit } from './graph.js';
import { UNNAMED } from './record-access.js';
import { areaOf } from './workspaces.js';

export interface Touch { unit: string; concept: string; line: number }

export interface EndingSpec { title: string; entries: string[] }

export interface FlowSpec { name: string; title: string; entries: string[]; concepts: string[]; endings?: EndingSpec[] }

export interface Ending { title: string; entries: string[]; missing: string[]; units: string[]; meets: string[] }

export interface FlowLink { from: string; to: string; through: Edge['through'] | 'within' }

export interface Gap { unit: string; at: string; through: Edge['through'] }

export interface Flow {
  name: string;
  title: string;
  entries: string[];
  missing: string[];
  units: string[];
  links: FlowLink[];
  touches: Touch[];
  gaps: Gap[];
  endings: Ending[];
}

export interface FileNode { file: string; area: string; entry: boolean; concepts: string[]; gaps: string[] }
export interface FileLink { from: string; to: string; through: string[] }
export interface FileFlow { files: FileNode[]; links: FileLink[] }

export interface Implementation { unit: string; file: string; line: number; callers: number }

export interface SnapshotEnding { title: string; missing: string[]; files: string[]; meets: string[] }
export interface SnapshotFlow { title: string; missing: string[]; files: FileFlow; touches: string[]; gaps: string[]; endings: SnapshotEnding[] }
export interface Snapshot { commit: string; flows: Record<string, SnapshotFlow>; concepts: Record<string, string[]> }

export interface Change { where: string; kind: 'added' | 'removed'; what: string }

const ownCode = (unit: Unit | undefined): unit is Unit => unit !== undefined && !unit.inTest;

export function nameOf(graph: Graph, id: string): string {
  const unit = graph.units[id];
  if (!unit) return id;
  return unit.name === '(anonymous)' || unit.name === '(module)' ? `${unit.file}:${unit.line}` : `${unit.file}#${unit.name}`;
}

const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
};

const lineAt = (starts: readonly number[], offset: number): number => {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
};

export function touchesIn(graph: Graph, sourceOf: (file: string) => string | undefined, concepts: readonly Concept[]): Touch[] {
  const touches = new Map<string, Touch>();
  const add = (unit: string, concept: string, line: number) => {
    const key = `${unit}|${concept}`;
    const known = touches.get(key);
    if (!known || line < known.line) touches.set(key, { unit, concept, line });
  };
  const byFile = new Map<string, Unit[]>();
  for (const unit of Object.values(graph.units)) {
    if (!ownCode(unit)) continue;
    byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);
  }
  const marked = concepts.filter((concept) => (concept.marks?.length ?? 0) > 0);
  for (const [file, units] of byFile) {
    for (const concept of concepts) {
      if (!concept.inFile?.test(file)) continue;
      for (const unit of units) if (unit.name !== '(module)') add(unit.id, concept.id, unit.line);
    }
    if (marked.length === 0) continue;
    const text = sourceOf(file);
    if (text === undefined) continue;
    const starts = lineStarts(text);
    const innermost = [...units].sort((a, b) => (a.end - a.start) - (b.end - b.start));
    for (const concept of marked) {
      for (const mark of concept.marks ?? []) {
        const pattern = new RegExp(mark.source, mark.flags.includes('g') ? mark.flags : `${mark.flags}g`);
        for (const match of text.matchAll(pattern)) {
          const offset = match.index;
          const unit = innermost.find((candidate) => candidate.start <= offset && offset < candidate.end);
          if (unit) add(unit.id, concept.id, lineAt(starts, offset));
        }
      }
    }
  }
  for (const edge of graph.edges) {
    if (!ownCode(graph.units[edge.from])) continue;
    for (const concept of concepts) if (concept.through?.includes(edge.through)) add(edge.from, concept.id, edge.site.line);
  }
  return [...touches.values()].sort((a, b) => a.unit.localeCompare(b.unit) || a.concept.localeCompare(b.concept));
}

export function enclosingUnits(graph: Graph): Map<string, string> {
  const byFile = new Map<string, Unit[]>();
  for (const unit of Object.values(graph.units)) {
    if (!ownCode(unit) || unit.name === '(module)') continue;
    byFile.set(unit.file, [...(byFile.get(unit.file) ?? []), unit]);
  }
  const parents = new Map<string, string>();
  for (const units of byFile.values()) {
    const bySize = [...units].sort((a, b) => (a.end - a.start) - (b.end - b.start));
    for (const unit of units) {
      const parent = bySize.find((candidate) => candidate !== unit && candidate.start <= unit.start && unit.end <= candidate.end && (candidate.end - candidate.start) > (unit.end - unit.start));
      if (parent) parents.set(unit.id, parent.id);
    }
  }
  return parents;
}

export function unitsNamed(graph: Graph, entry: string): string[] {
  const at = entry.lastIndexOf('#');
  if (at < 0) return [];
  const file = entry.slice(0, at);
  const name = entry.slice(at + 1);
  return Object.values(graph.units).filter((unit) => ownCode(unit) && unit.file === file && unit.name === name).map((unit) => unit.id);
}

const linksOf = (graph: Graph): Map<string, FlowLink[]> => {
  const out = new Map<string, FlowLink[]>();
  for (const edge of graph.edges) {
    if (!ownCode(graph.units[edge.from])) continue;
    for (const to of edge.to) {
      if (!ownCode(graph.units[to]) || to === edge.from) continue;
      out.set(edge.from, [...(out.get(edge.from) ?? []), { from: edge.from, to, through: edge.through }]);
    }
  }
  for (const [child, parent] of enclosingUnits(graph)) out.set(parent, [...(out.get(parent) ?? []), { from: parent, to: child, through: 'within' }]);
  return out;
};

const reachedFrom = (out: ReadonlyMap<string, FlowLink[]>, entries: readonly string[]): Set<string> => {
  const reached = new Set(entries);
  for (const queue = [...entries]; queue.length > 0;) {
    const unit = queue.pop()!;
    for (const link of out.get(unit) ?? []) {
      if (reached.has(link.to)) continue;
      reached.add(link.to);
      queue.push(link.to);
    }
  }
  return reached;
};

export function meetingPoints(graph: Graph, flow: ReadonlySet<string>, ending: ReadonlySet<string>): string[] {
  const written = new Set(graph.records.filter((record) => record.writes && flow.has(record.unit)).map((record) => record.collection));
  const read = new Set(graph.records.filter((record) => !record.writes && ending.has(record.unit)).map((record) => record.collection));
  const records = [...written].filter((collection) => collection !== UNNAMED && read.has(collection)).map((collection) => `record ${collection}`);
  const heard = graph.edges.filter((edge) => edge.through === 'socket' && flow.has(edge.from) && edge.to.some((to) => ending.has(to)))
    .map((edge) => `socket ${nameOf(graph, edge.from)} -> ${edge.to.filter((to) => ending.has(to)).map((to) => nameOf(graph, to)).join(', ')}`);
  return [...new Set([...records, ...heard])].sort();
}

export function flowFrom(graph: Graph, spec: FlowSpec, touches: readonly Touch[]): Flow {
  const wanted = new Set(spec.concepts);
  const touching = new Map<string, Touch[]>();
  for (const touch of touches) if (wanted.has(touch.concept)) touching.set(touch.unit, [...(touching.get(touch.unit) ?? []), touch]);
  const out = linksOf(graph);
  const unfollowed = new Map<string, Gap[]>();
  for (const edge of graph.edges) {
    if (!ownCode(graph.units[edge.from])) continue;
    if (edge.to.length === 0 && edge.through !== 'call') unfollowed.set(edge.from, [...(unfollowed.get(edge.from) ?? []), { unit: edge.from, at: `${edge.site.file}:${edge.site.line}`, through: edge.through }]);
  }
  const resolvedOf = (named: readonly string[]) => named.map((entry) => ({ entry, units: unitsNamed(graph, entry) }));
  const resolved = resolvedOf(spec.entries);
  const missing = resolved.filter((entry) => entry.units.length === 0).map((entry) => entry.entry);
  const entries = resolved.flatMap((entry) => entry.units);
  const reached = reachedFrom(out, entries);
  const endings = (spec.endings ?? []).map((ending): Ending => {
    const named = resolvedOf(ending.entries);
    const units = reachedFrom(out, named.flatMap((entry) => entry.units));
    return { title: ending.title, entries: named.flatMap((entry) => entry.units), missing: named.filter((entry) => entry.units.length === 0).map((entry) => entry.entry), units: [...units].sort(), meets: meetingPoints(graph, reached, units) };
  });
  const back = new Map<string, string[]>();
  for (const unit of reached) for (const link of out.get(unit) ?? []) if (reached.has(link.to)) back.set(link.to, [...(back.get(link.to) ?? []), unit]);
  const kept = new Set([...reached].filter((unit) => touching.has(unit) || unfollowed.has(unit)));
  for (const queue = [...kept]; queue.length > 0;) {
    const unit = queue.pop()!;
    for (const caller of back.get(unit) ?? []) {
      if (kept.has(caller)) continue;
      kept.add(caller);
      queue.push(caller);
    }
  }
  const seen = new Set<string>();
  const links: FlowLink[] = [];
  for (const unit of kept) {
    for (const link of out.get(unit) ?? []) {
      const key = `${link.from}>${link.to}>${link.through}`;
      if (!kept.has(link.to) || seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }
  return {
    name: spec.name,
    title: spec.title,
    entries: entries.filter((unit) => kept.has(unit)),
    missing,
    units: [...kept].sort(),
    links,
    touches: [...kept].flatMap((unit) => touching.get(unit) ?? []),
    gaps: [...kept].flatMap((unit) => unfollowed.get(unit) ?? []),
    endings,
  };
}

export function byFile(graph: Graph, flow: Flow): FileFlow {
  const fileOf = (id: string) => graph.units[id]?.file ?? id;
  const entryFiles = new Set(flow.entries.map(fileOf));
  const concepts = new Map<string, Set<string>>();
  for (const touch of flow.touches) {
    const file = fileOf(touch.unit);
    concepts.set(file, new Set([...(concepts.get(file) ?? []), touch.concept]));
  }
  const gaps = new Map<string, Set<string>>();
  for (const gap of flow.gaps) {
    const file = fileOf(gap.unit);
    gaps.set(file, new Set([...(gaps.get(file) ?? []), `${gap.at} (${gap.through})`]));
  }
  const files = [...new Set(flow.units.map(fileOf))].sort().map((file): FileNode => ({
    file, area: areaOf(file), entry: entryFiles.has(file), concepts: [...(concepts.get(file) ?? [])].sort(), gaps: [...(gaps.get(file) ?? [])].sort(),
  }));
  const links = new Map<string, FileLink>();
  for (const link of flow.links) {
    const from = fileOf(link.from);
    const to = fileOf(link.to);
    if (from === to) continue;
    const key = `${from}>${to}`;
    const known = links.get(key) ?? { from, to, through: [] };
    if (!known.through.includes(link.through)) known.through = [...known.through, link.through].sort();
    links.set(key, known);
  }
  return { files, links: [...links.values()].sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`)) };
}

export function conceptIndex(graph: Graph, touches: readonly Touch[], concept: string): Implementation[] {
  const callers = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!ownCode(graph.units[edge.from])) continue;
    for (const to of edge.to) callers.set(to, new Set([...(callers.get(to) ?? []), edge.from]));
  }
  return touches
    .filter((touch) => touch.concept === concept)
    .map((touch): Implementation => ({ unit: nameOf(graph, touch.unit), file: graph.units[touch.unit]?.file ?? touch.unit, line: touch.line, callers: callers.get(touch.unit)?.size ?? 0 }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function snapshotOf(graph: Graph, commit: string, flows: readonly Flow[], index: Record<string, readonly Implementation[]>): Snapshot {
  return {
    commit,
    flows: Object.fromEntries(flows.map((flow) => [flow.name, {
      title: flow.title,
      missing: flow.missing,
      files: byFile(graph, flow),
      touches: [...new Set(flow.touches.map((touch) => `${touch.concept} ${nameOf(graph, touch.unit)}`))].sort(),
      gaps: [...new Set(flow.gaps.map((gap) => `${gap.through} ${gap.at}`))].sort(),
      endings: flow.endings.map((ending) => ({ title: ending.title, missing: ending.missing, files: [...new Set(ending.units.map((unit) => graph.units[unit]?.file ?? unit))].sort(), meets: ending.meets })),
    }])),
    concepts: Object.fromEntries(Object.entries(index).map(([concept, implementations]) => [concept, [...new Set(implementations.map((entry) => entry.unit))].sort()])),
  };
}

const compared = (where: string, before: readonly string[], after: readonly string[]): Change[] => {
  const was = new Set(before);
  const now = new Set(after);
  return [
    ...after.filter((entry) => !was.has(entry)).map((what): Change => ({ where, kind: 'added', what })),
    ...before.filter((entry) => !now.has(entry)).map((what): Change => ({ where, kind: 'removed', what })),
  ];
};

const endingKeys = (flow: SnapshotFlow | undefined): string[] => (flow?.endings ?? []).map((ending) => `${ending.title}: ${ending.meets.length > 0 ? `meets at ${ending.meets.join('; ')}` : 'meets the flow nowhere'}`);

const linkKeys = (flow: SnapshotFlow | undefined): string[] => (flow?.files.links ?? []).map((link) => `${link.from} -> ${link.to}${link.through.some((through) => through !== 'call') ? ` (${link.through.join(', ')})` : ''}`);

export function flowDiff(before: Snapshot, after: Snapshot): Change[] {
  const flows = [...new Set([...Object.keys(before.flows), ...Object.keys(after.flows)])].sort();
  const concepts = [...new Set([...Object.keys(before.concepts), ...Object.keys(after.concepts)])].sort();
  return [
    ...flows.flatMap((flow) => [
      ...compared(`flow ${flow}`, linkKeys(before.flows[flow]), linkKeys(after.flows[flow])),
      ...compared(`flow ${flow}`, before.flows[flow]?.touches ?? [], after.flows[flow]?.touches ?? []),
      ...compared(`flow ${flow}, where the map stops`, before.flows[flow]?.gaps ?? [], after.flows[flow]?.gaps ?? []),
      ...compared(`flow ${flow}, how it ends`, endingKeys(before.flows[flow]), endingKeys(after.flows[flow])),
    ]),
    ...concepts.flatMap((concept) => compared(`concept ${concept}`, before.concepts[concept] ?? [], after.concepts[concept] ?? [])),
  ];
}

const label = (text: string): string => text.replace(/"/g, '#quot;');

export function mermaidOf(flow: FileFlow, labels: Readonly<Record<string, string>>): string {
  const ids = new Map(flow.files.map((node, at) => [node.file, `f${at}`]));
  const lines = ['flowchart LR'];
  for (const node of flow.files) {
    const touched = node.concepts.map((concept) => labels[concept] ?? concept).join(', ');
    const text = [node.area, basename(node.file), ...(touched ? [`<i>${touched}</i>`] : []), ...(node.gaps.length > 0 ? ['<b>map stops here</b>'] : [])].join('<br/>');
    const style = node.entry ? ':::entry' : node.gaps.length > 0 ? ':::gap' : node.concepts.length > 0 ? ':::touch' : '';
    lines.push(`  ${ids.get(node.file)}["${label(text)}"]${style}`);
  }
  for (const link of flow.links) {
    const crossing = link.through.filter((through) => through !== 'call' && through !== 'interface' && through !== 'render' && through !== 'reference');
    lines.push(`  ${ids.get(link.from)} -->${crossing.length > 0 ? `|${crossing.join(', ')}|` : ''} ${ids.get(link.to)}`);
  }
  lines.push('  classDef entry stroke-width:3px', '  classDef touch stroke-dasharray:4 2', '  classDef gap stroke-width:3px,stroke-dasharray:2 2');
  return lines.join('\n');
}
