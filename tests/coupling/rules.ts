import type { Artifact } from './artifacts.js';
import type { Edge, Graph } from './graph.js';
import type { Judged, Level } from './join.js';

export type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export const RULES: readonly Rule[] = ['R1', 'R2', 'R3', 'R4', 'R5'];

export const NEEDS: Record<Rule, readonly Artifact[]> = { R1: ['in-process'], R2: ['in-process'], R3: ['in-process'], R4: [], R5: ['in-process', 'live'] };

const LAYERED = /^apps\/backend\/src\/([a-z-]+\/(services|routes)\/|activities\/)/;
const REAL: ReadonlySet<Level> = new Set(['component', 'contract', 'container', 'live', 'vm']);

export function layerBreaches(graph: Graph, levels: ReadonlyMap<string, ReadonlySet<Level>>): Breach[] {
  const found: Breach[] = [];
  for (const unit of Object.values(graph.units)) {
    if (unit.inTest || unit.name === '(module)' || !LAYERED.test(unit.file)) continue;
    const ran = levels.get(unit.id) ?? new Set<Level>();
    const unitTested = ran.has('unit');
    const real = [...ran].some((level) => REAL.has(level));
    if (unitTested && real) continue;
    const why = !unitTested && !real ? 'no test runs it' : !unitTested ? 'no unit test runs it with its dependencies mocked' : 'no integration or live test runs it with its real dependencies';
    found.push({ rule: 'R5', key: `R5 ${unit.file}#${unit.name}`, at: `${unit.file}:${unit.line}`, why });
  }
  return found;
}

export interface Judging { judged: Rule[]; skipped: Array<{ rule: Rule; missing: Artifact[] }> }

export function judging(have: ReadonlySet<Artifact>): Judging {
  const judged: Rule[] = [];
  const skipped: Judging['skipped'] = [];
  for (const rule of RULES) {
    const missing = NEEDS[rule].filter((artifact) => !have.has(artifact));
    if (missing.length === 0) judged.push(rule);
    else skipped.push({ rule, missing });
  }
  return { judged, skipped };
}

const ruleOf = (key: string): string => key.slice(0, key.indexOf(' '));

export interface Breach { rule: Rule; key: string; at: string; why: string }

export type Baseline = Record<string, number>;

const BELOW_LIVE: ReadonlySet<Level> = new Set(['unit', 'component', 'contract', 'container']);
const CROSS_PROCESS: ReadonlySet<Edge['through']> = new Set(['temporal', 'socket', 'http', 'env']);

export const crossesProcess = (edge: Edge): boolean => CROSS_PROCESS.has(edge.through);

const STARTUP_CODE = /^apps\/backend\/src\/((index|worker-[a-z]+)\.ts$|[a-z-]+\/wiring\/)/;

export const isStartupCode = (file: string): boolean => STARTUP_CODE.test(file);

export function breaches(judged: readonly Judged[], graph: Graph, rules: readonly Rule[] = RULES): Breach[] {
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
    const startedLive = isStartupCode(graph.units[edge.from]?.file ?? '') && entry.covered.some((covered) => covered.level === 'live');
    if (!below && !startedLive) {
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
  return found.filter((breach) => rules.includes(breach.rule));
}

export function counted(found: readonly Breach[]): Baseline {
  const counts: Baseline = {};
  for (const breach of found) counts[breach.key] = (counts[breach.key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export interface Against { added: Breach[]; fixed: Array<{ key: string; was: number; now: number }> }

export function against(found: readonly Breach[], whole: Baseline, rules: readonly Rule[] = RULES, lowering: readonly Breach[] = found): Against {
  const baseline = Object.fromEntries(Object.entries(whole).filter(([key]) => (rules as readonly string[]).includes(ruleOf(key))));
  const now = counted(found);
  const added: Breach[] = [];
  for (const [key, count] of Object.entries(now)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) added.push(...found.filter((breach) => breach.key === key).slice(allowed));
  }
  const left = counted(lowering);
  const fixed = Object.entries(baseline).filter(([key, was]) => (left[key] ?? 0) < was).map(([key, was]) => ({ key, was, now: left[key] ?? 0 }));
  return { added, fixed };
}

export function pruned(baseline: Baseline, found: readonly Breach[], rules: readonly Rule[] = RULES): Baseline {
  const now = counted(found);
  const judgedNow = (key: string) => (rules as readonly string[]).includes(ruleOf(key));
  return Object.fromEntries(Object.entries(baseline).map(([key, was]): [string, number] => [key, judgedNow(key) ? Math.min(was, now[key] ?? 0) : was]).filter(([, count]) => count > 0));
}
