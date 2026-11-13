import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Ran, RanRange } from './collect.js';

const CODE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const UNREAD = /\.md$/;
const SEEN_BY_EVERY_TEST = [/(^|\/)vitest\.[^/]*\.ts$/, /(^|\/)vitest\.config\.ts$/, /^tests\/tiers\/(?!.*\.test\.ts$)/, /^tests\/coupling\/(vitest-setup|collect|shell-trace|live)\.ts$/, /(^|\/)package\.json$/, /(^|\/)tsconfig[^/]*\.json$/];

export type Rerun = { full: true; because: string } | { full: false; tests: string[] };

export interface Lines { changed: ReadonlySet<number>; insertedAfter: readonly number[] }

export type ChangedLines = ReadonlyMap<string, Lines | 'whole'>;

export function changedBetween(before: Readonly<Record<string, string>>, now: Readonly<Record<string, string>>): Set<string> {
  const changed = new Set<string>();
  for (const [file, hash] of Object.entries(now)) if (before[file] !== hash) changed.add(file);
  for (const file of Object.keys(before)) if (!(file in now)) changed.add(file);
  return changed;
}

const isModule = (range: RanRange): boolean => range.fn === '' && range.start.line === 1 && range.start.column === 1;

export function ranLine(ranges: readonly RanRange[], line: number): boolean {
  if (ranges.some((range) => range.fn === undefined && range.count === 0 && range.start.line < line && range.end.line > line)) return false;
  let inner: RanRange | undefined;
  for (const range of ranges) {
    if (range.fn === undefined || isModule(range) || range.start.line > line || range.end.line < line) continue;
    if (!inner || range.end.line - range.start.line < inner.end.line - inner.start.line) inner = range;
  }
  return inner ? inner.count > 0 : true;
}

const ranAny = (ranges: readonly RanRange[], lines: Lines | 'whole'): boolean =>
  lines === 'whole'
  || [...lines.changed].some((line) => ranLine(ranges, line))
  || lines.insertedAfter.some((line) => ranLine(ranges, line) && ranLine(ranges, line + 1));

export function testsToRerun(runs: readonly Ran[], changed: ChangedLines, tests: readonly string[]): Rerun {
  const unseen = [...changed.keys()].find((file) => !UNREAD.test(file) && (!CODE.test(file) || SEEN_BY_EVERY_TEST.some((pattern) => pattern.test(file))));
  if (unseen) return { full: true, because: unseen };
  const recorded = new Set(runs.map((run) => run.testFile));
  const picked = new Set<string>();
  for (const run of runs) {
    if (Object.entries(run.files).some(([file, ranges]) => { const lines = changed.get(file); return lines !== undefined && ranAny(ranges, lines); })) picked.add(run.testFile);
  }
  for (const test of tests) if (changed.has(test) || !recorded.has(test)) picked.add(test);
  return { full: false, tests: [...picked].filter((test) => tests.includes(test)).sort() };
}

const git = (root: string, args: readonly string[], input?: string): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...(input === undefined ? {} : { input }) });

export function fileHashes(root: string, paths: readonly string[]): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const line of git(root, ['ls-files', '-s', '--', ...paths]).split('\n').filter(Boolean)) {
    const [meta, file] = line.split('\t');
    hashes[file!] = meta!.split(' ')[1]!;
  }
  const touched = [
    ...git(root, ['diff', '--name-only', 'HEAD', '--', ...paths]).split('\n'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n'),
  ].filter(Boolean);
  const present = touched.filter((file) => existsSync(join(root, file)));
  for (const file of touched) if (!present.includes(file)) delete hashes[file];
  if (present.length > 0) {
    const kept = git(root, ['hash-object', '-w', '--stdin-paths'], `${present.join('\n')}\n`).split('\n').filter(Boolean);
    present.forEach((file, index) => { hashes[file] = kept[index]!; });
  }
  return hashes;
}

export function hunkLines(diff: string): Lines {
  const changed = new Set<number>();
  const insertedAfter: number[] = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) insertedAfter.push(start);
    else for (let line = start; line < start + count; line += 1) changed.add(line);
  }
  return { changed, insertedAfter };
}

const blobKnown = (root: string, blob: string): boolean => spawnSync('git', ['cat-file', '-e', `${blob}^{blob}`], { cwd: root }).status === 0;

export function changedLines(root: string, before: Readonly<Record<string, string>>, now: Readonly<Record<string, string>>, changed: ReadonlySet<string>): Map<string, Lines | 'whole'> {
  const lines = new Map<string, Lines | 'whole'>();
  for (const file of changed) {
    const was = before[file];
    const is = now[file];
    if (!was || !is || !CODE.test(file) || !blobKnown(root, was) || !blobKnown(root, is)) {
      lines.set(file, 'whole');
      continue;
    }
    lines.set(file, hunkLines(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', was, is])));
  }
  return lines;
}
