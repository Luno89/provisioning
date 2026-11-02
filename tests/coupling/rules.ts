import type { Edge, Graph } from './graph.js';
import type { Judged, Level } from './join.js';

export type Rule = 'R1' | 'R2' | 'R3' | 'R4';

export interface Breach { rule: Rule; key: string; at: string; why: string }

export type Baseline = Record<string, number>;

const BELOW_LIVE: ReadonlySet<Level> = new Set(['unit', 'component', 'contract', 'container']);
const CROSS_PROCESS: ReadonlySet<Edge['through']> = new Set(['temporal', 'socket', 'http', 'env']);

export const crossesProcess = (edge: Edge): boolean => CROSS_PROCESS.has(edge.through);

export function breaches(judged: readonly Judged[], graph: Graph): Breach[] {
  const name = (id: string) => { const unit = graph.units[id]; return unit ? `${unit.file}#${unit.name}` : id; };
  const callers = new Map<string, number>();
  for (const edge of graph.edges) for (const to of edge.to) callers.set(to, (callers.get(to) ?? 0) + 1);
  const found: Breach[] = [];
  for (const entry of judged) {
    const { edge } = entry;
    const at = `${edge.site.file}:${edge.site.line}`;
    const pair = `${name(edge.from)} -> ${edge.to.map(name).sort().join(' | ')} (${edge.through})`;
    if (edge.to.length === 0) {
      found.push({ rule: 'R4', key: `R4 ${pair}`, at, why: 'no implementation found for this call' });
      continue;
    }
    const crossing = crossesProcess(edge);
    const below = entry.covered.some((covered) => BELOW_LIVE.has(covered.level));
    if (!below) {
      const rule: Rule = crossing ? 'R3' : 'R1';
      const why = entry.covered.length > 0 ? `covered only at ${entry.lowest}` : 'no test runs both sides for real';
      found.push({ rule, key: `${rule} ${pair}`, at, why });
    }
    if (crossing || entry.crosses === 'area') {
      const entryPoint = (callers.get(edge.from) ?? 0) === 0;
      const withCaller = entryPoint ? entry.covered.length > 0 : entry.withCallerAt !== undefined;
      if (!withCaller) found.push({ rule: 'R2', key: `R2 ${pair}`, at, why: entryPoint ? 'an entry point no test reaches' : 'never tested together with what calls it' });
    }
  }
  for (const call of graph.unresolved) {
    found.push({ rule: 'R4', key: `R4 ${name(call.from)} -> ${call.text} (${call.why})`, at: `${call.site.file}:${call.site.line}`, why: call.why });
  }
  return found;
}

export function counted(found: readonly Breach[]): Baseline {
  const counts: Baseline = {};
  for (const breach of found) counts[breach.key] = (counts[breach.key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export interface Against { added: Breach[]; fixed: Array<{ key: string; was: number; now: number }> }

export function against(found: readonly Breach[], baseline: Baseline): Against {
  const now = counted(found);
  const added: Breach[] = [];
  for (const [key, count] of Object.entries(now)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) added.push(...found.filter((breach) => breach.key === key).slice(allowed));
  }
  const fixed = Object.entries(baseline).filter(([key, was]) => (now[key] ?? 0) < was).map(([key, was]) => ({ key, was, now: now[key] ?? 0 }));
  return { added, fixed };
}

export function pruned(baseline: Baseline, found: readonly Breach[]): Baseline {
  const now = counted(found);
  return Object.fromEntries(Object.entries(baseline).map(([key, was]): [string, number] => [key, Math.min(was, now[key] ?? 0)]).filter(([, count]) => count > 0));
}
