import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ran } from './collect.js';

const CODE = /\.(ts|tsx|mts|mjs|js|cjs)$/;
const UNREAD = /\.md$/;
const SEEN_BY_EVERY_TEST = [/(^|\/)vitest\.[^/]*\.ts$/, /(^|\/)vitest\.config\.ts$/, /^tests\/tiers\//, /^tests\/coupling\//, /(^|\/)package\.json$/, /(^|\/)tsconfig[^/]*\.json$/];

export type Rerun = { full: true; because: string } | { full: false; tests: string[] };

export function changedBetween(before: Readonly<Record<string, string>>, now: Readonly<Record<string, string>>): Set<string> {
  const changed = new Set<string>();
  for (const [file, hash] of Object.entries(now)) if (before[file] !== hash) changed.add(file);
  for (const file of Object.keys(before)) if (!(file in now)) changed.add(file);
  return changed;
}

export function testsToRerun(runs: readonly Ran[], changed: ReadonlySet<string>, tests: readonly string[]): Rerun {
  const unseen = [...changed].find((file) => !UNREAD.test(file) && (!CODE.test(file) || SEEN_BY_EVERY_TEST.some((pattern) => pattern.test(file))));
  if (unseen) return { full: true, because: unseen };
  const recorded = new Set(runs.map((run) => run.testFile));
  const picked = new Set<string>();
  for (const run of runs) if (Object.keys(run.files).some((file) => changed.has(file))) picked.add(run.testFile);
  for (const test of tests) if (changed.has(test) || !recorded.has(test)) picked.add(test);
  return { full: false, tests: [...picked].filter((test) => tests.includes(test)).sort() };
}

const git = (root: string, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

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
  for (const file of touched) {
    if (existsSync(join(root, file))) hashes[file] = createHash('sha1').update(readFileSync(join(root, file))).digest('hex');
    else delete hashes[file];
  }
  return hashes;
}
