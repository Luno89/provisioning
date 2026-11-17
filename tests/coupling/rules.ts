import type { Artifact } from './artifacts.js';
import type { Edge, Graph } from './graph.js';
import type { Judged, Level, Near } from './join.js';

export type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';
export const RULES: readonly Rule[] = ['R1', 'R2', 'R3', 'R4', 'R5'];

export const NEEDS: Record<Rule, readonly Artifact[]> = { R1: ['in-process'], R2: ['in-process'], R3: ['in-process'], R4: [], R5: ['in-process'] };

const LAYERED = /^apps\/backend\/src\/([a-z-]+\/(services|routes)\/|activities\/)/;
const REAL: ReadonlySet<Level> = new Set(['component', 'contract', 'container', 'live', 'vm']);

export function layerBreaches(graph: Graph, levels: ReadonlyMap<string, ReadonlySet<Level>>): Breach[] {
  const found: Breach[] = [];
  for (const unit of Object.values(graph.units)) {
    if (unit.inTest || unit.noBehaviour || unit.name === '(module)' || !LAYERED.test(unit.file)) continue;
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

export interface Breach { rule: Rule; key: string; at: string; why: string; near?: Near | undefined }

export type Baseline = Record<string, number>;

const BELOW_LIVE: ReadonlySet<Level> = new Set(['unit', 'component', 'contract', 'container']);
const CROSS_PROCESS: ReadonlySet<Edge['through']> = new Set(['temporal', 'socket', 'http', 'env']);

export const crossesProcess = (edge: Edge): boolean => CROSS_PROCESS.has(edge.through);

const unitName = (graph: Graph, id: string): string => { const unit = graph.units[id]; return unit ? `${unit.file}#${unit.name}` : id; };

export const callOf = (edge: Edge, graph: Graph): string => `${unitName(graph, edge.from)} -> ${edge.to.map((id) => unitName(graph, id)).sort().join(' | ')} (${edge.through})`;

export function breaches(judged: readonly Judged[], graph: Graph, rules: readonly Rule[] = RULES): Breach[] {
  const name = (id: string) => unitName(graph, id);
  const callers = new Map<string, number>();
  for (const edge of graph.edges) for (const to of edge.to) callers.set(to, (callers.get(to) ?? 0) + 1);
  const found: Breach[] = [];
  for (const entry of judged) {
    const { edge } = entry;
    const at = `${edge.site.file}:${edge.site.line}`;
    if (edge.to.length > 0 && edge.to.every((id) => graph.units[id]?.noBehaviour)) continue;
    const pair = callOf(edge, graph);
    if (edge.to.length === 0) {
      found.push({ rule: 'R4', key: `R4 ${pair}`, at, why: 'no implementation found for this call' });
      continue;
    }
    const crossing = crossesProcess(edge);
    const below = entry.covered.some((covered) => BELOW_LIVE.has(covered.level));
    if (!below) {
      const rule: Rule = crossing ? 'R3' : 'R1';
      const why = entry.covered.length > 0 ? `covered only at ${entry.lowest}` : 'no test runs both sides for real';
      found.push({ rule, key: `${rule} ${pair}`, at, why, ...(entry.near ? { near: entry.near } : {}) });
    }
    if (crossing || entry.crosses === 'area') {
      const entryPoint = (callers.get(edge.from) ?? 0) === 0;
      const withCaller = entryPoint ? entry.covered.length > 0 : entry.withCallerAt !== undefined;
      if (!withCaller) found.push({ rule: 'R2', key: `R2 ${pair}`, at, why: entryPoint ? 'an entry point no test reaches' : 'never tested together with what calls it', ...(entry.near ? { near: entry.near } : {}) });
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

export function pruned(baseline: Baseline, found: readonly Breach[], rules: readonly Rule[] = RULES, before?: Baseline): Baseline {
  const now = counted(found);
  const judgedNow = (key: string) => (rules as readonly string[]).includes(ruleOf(key));
  const steady = (key: string) => Math.max(now[key] ?? 0, before ? (before[key] ?? 0) : 0);
  return Object.fromEntries(Object.entries(baseline).map(([key, was]): [string, number] => [key, judgedNow(key) ? Math.min(was, steady(key)) : was]).filter(([, count]) => count > 0));
}

const KEY = /^(R\d) (\S+) -> (.+) \(([^()]+)\)$/;

interface KeyParts { rule: string; from: string; to: string[]; through: string }

const partsOf = (key: string): KeyParts | undefined => {
  const at = KEY.exec(key);
  return at ? { rule: at[1]!, from: at[2]!, to: at[3]!.split(' | '), through: at[4]! } : undefined;
};

const fileOf = (unit: string): string => unit.slice(0, unit.indexOf('#'));

const nameOf = (unit: string): string => unit.slice(unit.indexOf('#'));

const namesOf = (to: readonly string[]): string => to.map((unit) => unit.slice(unit.indexOf('#'))).sort().join(' | ');

export interface Move { from: string; to: string; count: number }

export function movedIn(baseline: Baseline, found: readonly Breach[]): { baseline: Baseline; moves: Move[] } {
  const now = counted(found);
  const gone = Object.keys(baseline).filter((key) => now[key] === undefined);
  const arrived = Object.keys(now).filter((key) => baseline[key] === undefined);
  const carried: Baseline = { ...baseline };
  const moves: Move[] = [];
  const taken = new Set<string>();
  for (const key of arrived) {
    const parts = partsOf(key);
    if (!parts) continue;
    const from = gone.find((old) => {
      if (taken.has(old)) return false;
      const was = partsOf(old);
      return was !== undefined && was.rule === parts.rule && was.through === parts.through
        && (fileOf(was.from) === fileOf(parts.from) || nameOf(was.from) === nameOf(parts.from)) && namesOf(was.to) === namesOf(parts.to);
    });
    if (!from) continue;
    taken.add(from);
    const count = baseline[from]!;
    delete carried[from];
    carried[key] = count;
    moves.push({ from, to: key, count });
  }
  return { baseline: Object.fromEntries(Object.entries(carried).sort(([a], [b]) => a.localeCompare(b))), moves };
}

const SHOWN = 3;

const listed = (tests: readonly string[]): string => (tests.length === 0 ? 'no test' : `${tests.slice(0, SHOWN).join(', ')}${tests.length > SHOWN ? ` and ${tests.length - SHOWN} more` : ''}`);

export function nearLines(near: Near, rule: Rule): string[] {
  return [
    `  its caller ran in: ${listed(near.callerRan)}`,
    `  its real target ran in: ${listed(near.targetRan)}`,
    ...(near.standIn.length ? [`  a stand-in answered in its place in: ${listed(near.standIn)}`] : []),
    ...(rule === 'R2' ? [`  what calls its caller ran in: ${listed(near.callersOfCallerRan)}`] : []),
  ];
}

export function neededTest(breach: Breach): string | undefined {
  const near = breach.near;
  const parts = partsOf(breach.key);
  if (!near || !parts) return undefined;
  const from = parts.from;
  const to = parts.to.join(' or ');
  if (breach.rule === 'R2') {
    return near.callersOfCallerRan.length
      ? `  needs: one test that starts where ${from} is called from (as ${listed(near.callersOfCallerRan)} does) and goes on through it to ${to}`
      : `  needs: a test that reaches ${from} from where it starts and goes on through it to ${to}`;
  }
  if (near.untaken) return `  needs: a test that takes the branch at ${breach.at} (lines ${near.untaken.from}-${near.untaken.to}, which ${near.untaken.test} runs past) with the real ${to}`;
  if (near.callerRan.length === 0) return `  needs: a test that runs ${from}, which no test runs yet, through to the real ${to}`;
  if (near.targetRan.length === 0) return `  needs: a test that runs ${to} for real when ${from} calls it; nothing runs it for real yet`;
  if (near.standIn.length > 0) return `  needs: one test that runs ${from} with the real ${to}, where ${listed(near.standIn)} gives it a stand-in`;
  return `  needs: one test that runs ${from} with the real ${to}; they only run apart`;
}

export function sameCallBefore(baseline: Baseline, found: readonly Breach[], added: readonly Breach[]): Array<{ key: string; was: string[] }> {
  const now = counted(found);
  const gone = Object.keys(baseline).filter((key) => now[key] === undefined);
  return added.flatMap((breach) => {
    const parts = partsOf(breach.key);
    if (!parts) return [];
    const was = gone.filter((old) => {
      const before = partsOf(old);
      return before !== undefined && before.rule === parts.rule && before.from === parts.from && before.through === parts.through;
    });
    return was.length ? [{ key: breach.key, was }] : [];
  });
}
