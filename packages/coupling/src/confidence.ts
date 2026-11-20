export type Layer = 'unit' | 'component' | 'contract' | 'container' | 'vm';
export const LAYERS: readonly Layer[] = ['unit', 'component', 'contract', 'container', 'vm'];

export type Kind = 'logic' | 'composition' | 'dependency';

export interface CodeUnit { id: string; file: string; name: string; line: number }

export interface Link { id: string; from: string; to: string[]; kind: Kind; path?: string[] }

export interface Run { test: string; layer: Layer; units: string[]; links: string[] }

export interface History { changes?: Record<string, number>; failures?: Record<string, number> }

export interface Codebase { units: CodeUnit[]; links: Link[]; runs: Run[]; changed: string[]; history?: History }

export type Weights = Record<Layer, number>;

export interface JudgedLink extends Link {
  provenAt: Layer[];
  provenBy: string[];
  confidence: number;
  sharedFrom?: string;
  risk: number;
}

export interface Judgement { units: CodeUnit[]; links: JudgedLink[]; untested: CodeUnit[]; blocking: CodeUnit[] }

const AGAINST_THE_REAL_THING: ReadonlySet<Layer> = new Set(['contract', 'container', 'vm']);

const proves = (link: Link, run: Run): boolean =>
  run.links.includes(link.id) && (link.kind !== 'dependency' || AGAINST_THE_REAL_THING.has(run.layer));

const confidenceOf = (layers: readonly Layer[], weights: Weights): number =>
  1 - layers.reduce((left, layer) => left * (1 - weights[layer]), 1);

const sharedLength = (a: readonly string[], b: readonly string[]): number => {
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  return at;
};

function lent(link: Link, proven: readonly JudgedLink[]): { confidence: number; from: string } | undefined {
  if (link.kind !== 'dependency' || !link.path || link.path.length === 0) return undefined;
  let best: { confidence: number; from: string } | undefined;
  for (const sibling of proven) {
    if (sibling.kind !== 'dependency' || !sibling.path || sibling.id === link.id) continue;
    const share = sharedLength(link.path, sibling.path) / Math.max(link.path.length, sibling.path.length);
    const confidence = sibling.confidence * share;
    if (confidence > 0 && (!best || confidence > best.confidence)) best = { confidence, from: sibling.id };
  }
  return best;
}

export function judge(codebase: Codebase, weights: Weights): Judgement {
  const changes = codebase.history?.changes ?? {};
  const failures = codebase.history?.failures ?? {};
  const direct: JudgedLink[] = codebase.links.map((link) => {
    const proving = codebase.runs.filter((run) => proves(link, run));
    const provenAt = LAYERS.filter((layer) => proving.some((run) => run.layer === layer));
    return { ...link, provenAt, provenBy: [...new Set(proving.map((run) => run.test))].sort(), confidence: confidenceOf(provenAt, weights), risk: 0 };
  });
  const proven = direct.filter((link) => link.confidence > 0);
  const links = direct.map((link): JudgedLink => {
    const borrowed = link.confidence === 0 ? lent(link, proven) : undefined;
    const confidence = borrowed?.confidence ?? link.confidence;
    const risk = (1 - confidence) * (1 + (changes[link.from] ?? 0)) * (1 + (failures[link.from] ?? 0));
    return { ...link, confidence, risk, ...(borrowed ? { sharedFrom: borrowed.from } : {}) };
  });
  const ran = new Set(codebase.runs.flatMap((run) => run.units));
  const changed = new Set(codebase.changed);
  const byId = (a: CodeUnit, b: CodeUnit) => a.id.localeCompare(b.id);
  const untested = codebase.units.filter((unit) => !ran.has(unit.id)).sort(byId);
  return {
    units: codebase.units,
    links: links.map((link, index) => ({ link, index })).sort((a, b) => b.link.risk - a.link.risk || a.index - b.index).map(({ link }) => link),
    untested,
    blocking: untested.filter((unit) => changed.has(unit.id)),
  };
}

const KINDS: readonly Kind[] = ['logic', 'composition', 'dependency'];

const provenLine = (link: JudgedLink): string =>
  link.provenAt.length > 0 ? `proven at ${link.provenAt.join(', ')}` : link.sharedFrom ? `lent proof by ${link.sharedFrom}` : 'proven nowhere';

export function reportOf(judged: Judgement, riskiest: number): string {
  const lines = [`${judged.links.length} links: ${KINDS.map((kind) => {
    const of = judged.links.filter((link) => link.kind === kind);
    return `${kind} ${of.length} (${of.filter((link) => link.confidence > 0).length} proven)`;
  }).join(', ')}`];
  lines.push(`${judged.untested.length} of ${judged.units.length} functions no test runs`);
  lines.push('riskiest:');
  for (const link of judged.links.slice(0, riskiest)) lines.push(`  ${link.risk.toFixed(2)}  ${link.id} ${link.kind}, ${provenLine(link)}`);
  if (judged.blocking.length > 0) {
    lines.push('changed code no test runs (blocks):');
    for (const unit of judged.blocking) lines.push(`  ${unit.file}:${unit.line} ${unit.name}`);
  }
  return lines.join('\n');
}
