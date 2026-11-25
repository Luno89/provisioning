export type Layer = 'unit' | 'component' | 'contract' | 'container' | 'vm';
export const LAYERS: readonly Layer[] = ['unit', 'component', 'contract', 'container', 'vm'];

export type Kind = 'logic' | 'composition' | 'dependency';

export interface CodeUnit { id: string; file: string; name: string; line: number; within?: string; assembles?: boolean }

export interface Link { id: string; from: string; to: string[]; kind: Kind; path?: string[]; realFrom?: Layer }

export interface Run { test: string; layer: Layer; units: string[]; links: string[]; versions?: Record<string, string>; expired?: string[] }

export interface History { changes?: Record<string, number>; failures?: Record<string, number>; faults?: Record<string, number> }

export interface Unchecked { survived: number; examples: string[] }

export interface Score { caught: number; missed: number }

export interface Codebase { units: CodeUnit[]; links: Link[]; runs: Run[]; changed: string[]; versions?: Record<string, string>; history?: History; unchecked?: Record<string, Unchecked>; scores?: Record<string, Score> }

export type Weights = Record<Layer, number>;

export interface Sharing { service: number; resource: number; operation: number }

export const EVEN_SHARING: Sharing = { service: 1 / 3, resource: 1 / 3, operation: 1 / 3 };

export interface SharingByKind { dependency?: Sharing; composition?: { target: number } }

export interface JudgedLink extends Link {
  provenAt: Layer[];
  provenBy: string[];
  confidence: number;
  sharedFrom?: string;
  risk: number;
}

export interface JudgedUnit extends CodeUnit { runAt: Layer[]; confidence: number; lentBy?: string; scored?: Score; risk: number }

const SCORE_STRENGTH = 10;

export interface Blocked extends CodeUnit { reason: string }

export interface Judgement { units: CodeUnit[]; functions: JudgedUnit[]; links: JudgedLink[]; untested: CodeUnit[]; blocking: Blocked[]; unchecked: Array<CodeUnit & Unchecked> }

const REAL_FROM: Layer = 'contract';

const atOrAbove = (layer: Layer, floor: Layer): boolean => LAYERS.indexOf(layer) >= LAYERS.indexOf(floor);

const sameVersion = (link: Link, run: Run, versions: Record<string, string> | undefined): boolean => {
  const service = link.path?.[0];
  if (service === undefined) return true;
  const today = versions?.[service];
  return today === undefined || run.versions?.[service] === today;
};

const stillTrue = (link: Link, run: Run): boolean => {
  const expired = new Set(run.expired ?? []);
  return !expired.has(link.from) && !link.to.some((id) => expired.has(id));
};

const proves = (link: Link, run: Run, versions: Record<string, string> | undefined): boolean =>
  run.links.includes(link.id)
  && stillTrue(link, run)
  && (link.kind !== 'dependency' || (atOrAbove(run.layer, link.realFrom ?? REAL_FROM) && sameVersion(link, run, versions)));

const confidenceOf = (layers: readonly Layer[], weights: Weights): number =>
  1 - layers.reduce((left, layer) => left * (1 - weights[layer]), 1);

const sameParts = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((part, at) => part === b[at]);

function shareOf(a: readonly string[], b: readonly string[], sharing: Sharing): number {
  if (a.length === 0 || b.length === 0 || a[0] !== b[0]) return 0;
  if (!sameParts(a.slice(1, -1), b.slice(1, -1))) return sharing.service;
  if (a.at(-1) !== b.at(-1)) return sharing.service + sharing.resource;
  return sharing.service + sharing.resource + sharing.operation;
}

const sameTargets = (a: readonly string[], b: readonly string[]): boolean => a.length > 0 && sameParts([...a].sort(), [...b].sort());

function shared(link: Link, sibling: JudgedLink, sharing: SharingByKind): number {
  if (sibling.id === link.id || sibling.kind !== link.kind) return 0;
  if (link.kind === 'dependency') return link.path && sibling.path && sharing.dependency ? shareOf(link.path, sibling.path, sharing.dependency) : 0;
  if (link.kind === 'composition') return sharing.composition && sameTargets(link.to, sibling.to) ? sharing.composition.target : 0;
  return 0;
}

function lent(link: Link, proven: readonly JudgedLink[], sharing: SharingByKind): { confidence: number; from: string } | undefined {
  let best: { confidence: number; from: string } | undefined;
  for (const sibling of proven) {
    const confidence = sibling.confidence * shared(link, sibling, sharing);
    if (confidence > 0 && (!best || confidence > best.confidence)) best = { confidence, from: sibling.id };
  }
  return best;
}

function adaptersOf(units: readonly CodeUnit[], links: readonly Link[], calling: ReadonlySet<string>): Set<string> {
  const fileOf = new Map(units.map((unit) => [unit.id, unit.file]));
  const callers = new Map<string, string[]>();
  for (const link of links) {
    if (link.kind !== 'logic') continue;
    for (const to of link.to) if (to !== link.from && fileOf.get(to) === fileOf.get(link.from)) callers.set(to, [...(callers.get(to) ?? []), link.from]);
  }
  const reaching = new Set(calling);
  const waiting = [...calling];
  for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
    for (const caller of callers.get(next) ?? []) if (!reaching.has(caller)) { reaching.add(caller); waiting.push(caller); }
  }
  for (const unit of units) if (unit.within !== undefined && calling.has(unit.within)) reaching.add(unit.id);
  return reaching;
}

const riskiestFirst = <T extends { risk: number }>(list: readonly T[]): T[] =>
  list.map((item, index) => ({ item, index })).sort((a, b) => b.item.risk - a.item.risk || a.index - b.index).map(({ item }) => item);

export function judge(codebase: Codebase, weights: Weights, sharing: SharingByKind = { dependency: EVEN_SHARING }): Judgement {
  const changes = codebase.history?.changes ?? {};
  const failures = codebase.history?.failures ?? {};
  const faults = codebase.history?.faults ?? {};
  const fileOf = new Map(codebase.units.map((unit) => [unit.id, unit.file]));
  const weight = (unit: string): number => (1 + Math.log2(1 + (changes[unit] ?? 0))) * (1 + (failures[unit] ?? 0)) * (1 + (faults[fileOf.get(unit) ?? ''] ?? 0));
  const direct: JudgedLink[] = codebase.links.map((link) => {
    const proving = codebase.runs.filter((run) => proves(link, run, codebase.versions));
    const provenAt = LAYERS.filter((layer) => proving.some((run) => run.layer === layer));
    return { ...link, provenAt, provenBy: [...new Set(proving.map((run) => run.test))].sort(), confidence: confidenceOf(provenAt, weights), risk: 0 };
  });
  const proven = direct.filter((link) => link.confidence > 0);
  const links = direct.map((link): JudgedLink => {
    const borrowed = link.confidence === 0 ? lent(link, proven, sharing) : undefined;
    const confidence = borrowed?.confidence ?? link.confidence;
    return { ...link, confidence, risk: (1 - confidence) * weight(link.from), ...(borrowed ? { sharedFrom: borrowed.from } : {}) };
  });
  const ranAt = new Map<string, Set<Layer>>();
  for (const run of codebase.runs) {
    const expired = new Set(run.expired ?? []);
    for (const unit of run.units) if (!expired.has(unit)) ranAt.set(unit, (ranAt.get(unit) ?? new Set<Layer>()).add(run.layer));
  }
  const outward = new Map<string, JudgedLink[]>();
  for (const link of links) if (link.kind === 'dependency') outward.set(link.from, [...(outward.get(link.from) ?? []), link]);
  const borrowedBy = (unit: string): { confidence: number; from: string } | undefined => {
    const calls = outward.get(unit) ?? [];
    if (calls.length === 0 || calls.some((call) => call.sharedFrom === undefined)) return undefined;
    const weakest = calls.reduce((low, call) => (call.confidence < low.confidence ? call : low));
    return { confidence: weakest.confidence, from: weakest.sharedFrom! };
  };
  const reaching = adaptersOf(codebase.units, links, new Set(outward.keys()));
  const functions = codebase.units.map((unit): JudgedUnit => {
    const runAt = LAYERS.filter((layer) => ranAt.get(unit.id)?.has(layer));
    const borrowed = runAt.length === 0 ? borrowedBy(unit.id) : undefined;
    const fromLayers = borrowed?.confidence ?? confidenceOf(runAt, weights);
    const scored = codebase.scores?.[unit.id];
    const confidence = scored ? (fromLayers * SCORE_STRENGTH + scored.caught) / (SCORE_STRENGTH + scored.caught + scored.missed) : fromLayers;
    return { ...unit, runAt, confidence, risk: (1 - confidence) * weight(unit.id), ...(borrowed ? { lentBy: borrowed.from } : {}), ...(scored ? { scored } : {}) };
  });
  const changed = new Set(codebase.changed);
  const untested = codebase.units.filter((unit) => !ranAt.has(unit.id)).sort((a, b) => a.id.localeCompare(b.id));
  const reasonOf = (unit: CodeUnit): string | undefined => {
    const layers = ranAt.get(unit.id);
    if (layers === undefined) return 'no test runs it';
    if (layers.has('unit') || reaching.has(unit.id) || unit.assembles) return undefined;
    return `runs only at ${LAYERS.filter((layer) => layers.has(layer)).join(', ')}; its logic needs a unit test`;
  };
  const blocking = codebase.units.filter((unit) => changed.has(unit.id)).sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((unit): Blocked[] => { const reason = reasonOf(unit); return reason === undefined ? [] : [{ ...unit, reason }]; });
  return {
    units: codebase.units,
    functions: riskiestFirst(functions),
    links: riskiestFirst(links),
    untested,
    blocking,
    unchecked: codebase.units.flatMap((unit) => { const missed = codebase.unchecked?.[unit.id]; return missed ? [{ ...unit, ...missed }] : []; }).sort((a, b) => b.survived - a.survived),
  };
}

const KINDS: readonly Kind[] = ['logic', 'composition', 'dependency'];

const provenLine = (link: JudgedLink): string =>
  link.provenAt.length > 0 ? `proven at ${link.provenAt.join(', ')}` : link.sharedFrom ? `lent proof by ${link.sharedFrom}` : 'proven nowhere';

export function reportOf(judged: Judgement, riskiest: number): string {
  const lines = [`${judged.links.length} links: ${KINDS.map((kind) => {
    const of = judged.links.filter((link) => link.kind === kind);
    const proven = of.filter((link) => link.provenAt.length > 0).length;
    const lentProof = of.filter((link) => link.sharedFrom !== undefined).length;
    return `${kind} ${of.length} (${proven} proven${lentProof > 0 ? `, ${lentProof} lent` : ''})`;
  }).join(', ')}`];
  lines.push(`${judged.untested.length} of ${judged.units.length} functions no test runs`);
  lines.push('riskiest links:');
  for (const link of judged.links.slice(0, riskiest)) lines.push(`  ${link.risk.toFixed(2)}  ${link.id} ${link.kind}, ${provenLine(link)}`);
  lines.push('riskiest functions:');
  for (const unit of judged.functions.slice(0, riskiest)) lines.push(`  ${unit.risk.toFixed(2)}  ${unit.file}:${unit.line} ${unit.name}, ${unit.runAt.length > 0 ? `run at ${unit.runAt.join(', ')}` : unit.lentBy ? `run nowhere, lent proof by ${unit.lentBy}` : 'run nowhere'}`);
  if (judged.blocking.length > 0) {
    lines.push('changed code the coupler refuses (blocks):');
    for (const unit of judged.blocking) lines.push(`  ${unit.file}:${unit.line} ${unit.name}: ${unit.reason}`);
  }
  if (judged.unchecked.length > 0) {
    lines.push('tests let planted faults through:');
    for (const unit of judged.unchecked.slice(0, riskiest)) {
      lines.push(`  ${unit.survived}  ${unit.file}:${unit.line} ${unit.name}`);
      for (const example of unit.examples) lines.push(`       ${example}`);
    }
  }
  return lines.join('\n');
}

export type UntestedList = Record<string, number>;

const keyOf = (unit: CodeUnit): string => `${unit.file}#${unit.name}`;

export function untestedList(untested: readonly CodeUnit[]): UntestedList {
  const list: UntestedList = {};
  for (const unit of untested) list[keyOf(unit)] = (list[keyOf(unit)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(list).sort(([a], [b]) => a.localeCompare(b)));
}

export interface Held { added: string[]; fixed: Array<{ key: string; was: number; now: number }> }

export function heldTo(untested: readonly CodeUnit[], list: UntestedList): Held {
  const now = untestedList(untested);
  const added = Object.entries(now).filter(([key, count]) => count > (list[key] ?? 0)).map(([key]) => key);
  const fixed = Object.entries(list).filter(([key, was]) => (now[key] ?? 0) < was).map(([key, was]) => ({ key, was, now: now[key] ?? 0 }));
  return { added, fixed };
}

export interface Evidence { layer: Layer; caught: boolean; age?: number }

export interface Learning { strength: number; halfLife?: number }

export interface Learned { weights: Weights; evidence: Record<Layer, { caught: number; missed: number }> }

export function learnedWeights(prior: Weights, evidence: readonly Evidence[], learning: Learning): Learned {
  const weights = { ...prior };
  const counted = Object.fromEntries(LAYERS.map((layer) => [layer, { caught: 0, missed: 0 }])) as Learned['evidence'];
  for (const layer of LAYERS) {
    let caught = 0;
    let missed = 0;
    for (const seen of evidence) {
      if (seen.layer !== layer) continue;
      const counts = learning.halfLife ? 0.5 ** ((seen.age ?? 0) / learning.halfLife) : 1;
      if (seen.caught) { caught += counts; counted[layer].caught += 1; } else { missed += counts; counted[layer].missed += 1; }
    }
    weights[layer] = (prior[layer] * learning.strength + caught) / (learning.strength + caught + missed);
  }
  return { weights, evidence: counted };
}
