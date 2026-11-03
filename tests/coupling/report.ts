import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ran } from './collect.js';
import type { Graph } from './graph.js';
import type { Judged, Level } from './join.js';
import { areaOf } from './workspaces.js';


export const STARTUP = 'startup';

export const levelOf = (testFile: string): Level => (/-live\.ts$/.test(testFile) || testFile === STARTUP ? 'live' : /\.integration\.test\.[a-z]+$/.test(testFile) ? 'component' : 'unit');

export function runsIn(dir: string): Ran[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Ran);
}

export interface AreaCount { area: string; edges: number; crossing: number; covered: number; crossingCovered: number; withCaller: number; noImplementation: number }

export function byArea(judged: readonly Judged[], graph: Graph): AreaCount[] {
  const counts = new Map<string, AreaCount>();
  for (const entry of judged) {
    const from = graph.units[entry.edge.from];
    if (!from) continue;
    const area = areaOf(from.file);
    const count = counts.get(area) ?? { area, edges: 0, crossing: 0, covered: 0, crossingCovered: 0, withCaller: 0, noImplementation: 0 };
    count.edges += 1;
    if (entry.covered.length > 0) count.covered += 1;
    if (entry.edge.to.length === 0) count.noImplementation += 1;
    if (entry.crosses === 'area') {
      count.crossing += 1;
      if (entry.covered.length > 0) count.crossingCovered += 1;
      if (entry.withCallerAt !== undefined) count.withCaller += 1;
    }
    counts.set(area, count);
  }
  return [...counts.values()].sort((a, b) => (b.crossing - b.crossingCovered) - (a.crossing - a.crossingCovered));
}

export function summary(judged: readonly Judged[], graph: Graph, gapsShown = 4): string {
  const unitName = (id: string) => { const unit = graph.units[id]; return unit ? `${unit.file}#${unit.name}` : id; };
  const lines: string[] = [];
  const crossing = judged.filter((entry) => entry.crosses === 'area');
  const count = (list: readonly Judged[], test: (entry: Judged) => boolean) => list.filter(test).length;
  lines.push(`${judged.length} edges, ${crossing.length} between areas, ${graph.unresolved.length} calls through any`);
  lines.push(`  covered for real by some test: ${count(judged, (entry) => entry.covered.length > 0)} of ${judged.length}`);
  lines.push(`  between areas, covered: ${count(crossing, (entry) => entry.covered.length > 0)}; also with its caller: ${count(crossing, (entry) => entry.withCallerAt !== undefined)}`);
  lines.push(`  no real implementation found: ${count(judged, (entry) => entry.edge.to.length === 0)}`);
  lines.push('by area (between-area edges uncovered first):');
  for (const area of byArea(judged, graph)) {
    lines.push(`  ${area.area.padEnd(28)} ${String(area.edges).padStart(5)} edges, ${area.covered} covered; between areas ${area.crossingCovered}/${area.crossing} covered, ${area.withCaller} with caller; ${area.noImplementation} with no implementation`);
  }
  const gaps = crossing.filter((entry) => entry.covered.length === 0 && entry.edge.to.length > 0);
  const byFile = new Map<string, Judged[]>();
  for (const gap of gaps) byFile.set(gap.edge.site.file, [...(byFile.get(gap.edge.site.file) ?? []), gap]);
  lines.push(`between-area edges no test runs for real, by file (${gaps.length}):`);
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${file} (${list.length})`);
    for (const gap of list.slice(0, gapsShown)) lines.push(`    :${gap.edge.site.line} ${unitName(gap.edge.from)} → ${gap.edge.to.map(unitName).join(' | ')}`);
  }
  return lines.join('\n');
}
