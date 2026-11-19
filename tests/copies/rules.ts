import { createHash } from 'node:crypto';
import ts from 'typescript';

export type Scope = 'src' | 'tests';
export interface Side { file: string; start: number; end: number }
export interface Copy { scope: Scope; a: Side; b: Side; fragment: string }
export type Baseline = Record<string, number>;
export interface Region { from: number; to: number; authority: string }
export interface Against { added: Copy[]; fixed: Array<{ key: string; was: number; now: number }> }
export interface Move { from: string; to: string; count: number }

export const MARKER = '── DUPLICATED, KNOWINGLY ──';

const hashOf = (fragment: string): string => createHash('sha256').update(fragment.replace(/\s+/g, '')).digest('hex').slice(0, 12);

export const keyOf = (copy: Copy): string => {
  const [first, second] = [copy.a.file, copy.b.file].sort();
  return `${copy.scope} ${first} <-> ${second} #${hashOf(copy.fragment)}`;
};

export const where = (copy: Copy): string => `${copy.a.file}:${copy.a.start}-${copy.a.end} <-> ${copy.b.file}:${copy.b.start}-${copy.b.end}`;

const sortedBaseline = (counts: Baseline): Baseline => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

export function counted(found: readonly Copy[]): Baseline {
  const counts: Baseline = {};
  for (const copy of found) counts[keyOf(copy)] = (counts[keyOf(copy)] ?? 0) + 1;
  return sortedBaseline(counts);
}

export function against(found: readonly Copy[], baseline: Baseline): Against {
  const now = counted(found);
  const added: Copy[] = [];
  for (const [key, count] of Object.entries(now)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) added.push(...found.filter((copy) => keyOf(copy) === key).slice(allowed));
  }
  const fixed = Object.entries(baseline).filter(([key, was]) => (now[key] ?? 0) < was).map(([key, was]) => ({ key, was, now: now[key] ?? 0 }));
  return { added, fixed };
}

export function pruned(baseline: Baseline, found: readonly Copy[]): Baseline {
  const now = counted(found);
  return Object.fromEntries(Object.entries(baseline).map(([key, was]): [string, number] => [key, Math.min(was, now[key] ?? 0)]).filter(([, count]) => count > 0));
}

const KEY = /^(\S+) (\S+) <-> (\S+) #([0-9a-f]+)$/;

const partsOf = (key: string): { scope: string; files: [string, string]; hash: string } | undefined => {
  const at = KEY.exec(key);
  return at ? { scope: at[1]!, files: [at[2]!, at[3]!], hash: at[4]! } : undefined;
};

export function movedIn(baseline: Baseline, found: readonly Copy[]): { baseline: Baseline; moves: Move[] } {
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
      const was = partsOf(old);
      return !taken.has(old) && was !== undefined && was.scope === parts.scope && was.hash === parts.hash && was.files.some((file) => parts.files.includes(file));
    });
    if (!from) continue;
    taken.add(from);
    const count = baseline[from]!;
    delete carried[from];
    carried[key] = count;
    moves.push({ from, to: key, count });
  }
  return { baseline: sortedBaseline(carried), moves };
}

const kindOf = (file: string): ts.ScriptKind => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.js') || file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS);

export function markedRegions(text: string, file: string): Region[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindOf(file));
  const lineOf = (position: number) => source.getLineAndCharacterOfPosition(position).line + 1;
  const regions: Region[] = [];
  let open: Region | undefined;
  for (const statement of source.statements) {
    const comments = (ts.getLeadingCommentRanges(text, statement.pos) ?? []).map((range) => text.slice(range.pos, range.end));
    if (comments.length > 0) {
      open = comments.some((comment) => comment.includes(MARKER)) ? { from: lineOf(statement.getStart(source)), to: 0, authority: comments.join('\n') } : undefined;
      if (open) regions.push(open);
    }
    if (open) open.to = lineOf(statement.getEnd());
  }
  return regions;
}

const coveredBy = (side: Side, other: string, regions: readonly Region[]): boolean =>
  regions.some((region) => region.from <= side.start && side.end <= region.to && region.authority.includes(other));

export const exempt = (copy: Copy, regions: (file: string) => readonly Region[]): boolean =>
  coveredBy(copy.a, copy.b.file, regions(copy.a.file)) || coveredBy(copy.b, copy.a.file, regions(copy.b.file));

export const markedWithout = (copy: Copy, regions: (file: string) => readonly Region[]): string[] =>
  ([[copy.a, copy.b.file], [copy.b, copy.a.file]] as const).flatMap(([side, other]) =>
    regions(side.file).filter((region) => region.from <= side.end && side.start <= region.to && !region.authority.includes(other)).map((region) => `${side.file}:${region.from} is marked, but its authority does not name ${other}`));
