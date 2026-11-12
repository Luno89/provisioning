import { dirname, join, normalize } from 'node:path';
import type { Ran } from './collect.js';
import { ranLine } from './impact.js';

export interface Injection { key: string; line: number }

export function injectionsIn(text: string): Injection[] {
  const found: Injection[] = [];
  text.split('\n').forEach((content, index) => {
    for (const match of content.matchAll(/\binject\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) found.push({ key: match[1]!, line: index + 1 });
  });
  return found;
}

export const providedIn = (text: string): string[] => [...text.matchAll(/\.provide\(\s*'([A-Za-z0-9_]+)'/g)].map((match) => match[1]!);

const IMPORTED = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)'(\.{1,2}\/[^']+)'/g;
const CANDIDATES = (path: string): string[] => {
  const bare = path.replace(/\.(js|mjs|cjs)$/, '');
  return [`${bare}.ts`, `${bare}.tsx`, `${bare}.mts`, path, join(bare, 'index.ts')];
};

export function importedFrom(file: string, text: string, exists: (file: string) => boolean): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IMPORTED)) {
    const target = CANDIDATES(normalize(join(dirname(file), match[1]!))).find(exists);
    if (target) found.push(target);
  }
  return found;
}

export interface SetupWorld {
  read: (file: string) => string | undefined;
  exists: (file: string) => boolean;
  providers: ReadonlyMap<string, string>;
}

function keysReachedFrom(test: string, world: SetupWorld): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<string>();
  const queue = [test];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = world.read(file);
    if (text === undefined) continue;
    for (const injection of injectionsIn(text)) keys.add(injection.key);
    queue.push(...importedFrom(file, text, world.exists));
  }
  return keys;
}

function keysRanBy(test: string, runs: readonly Ran[], changed: ReadonlySet<string>, world: SetupWorld): Set<string> {
  const keys = new Set(injectionsIn(world.read(test) ?? '').map((injection) => injection.key));
  for (const [file, ranges] of runs.flatMap((run) => Object.entries(run.files))) {
    const text = world.read(file);
    if (text === undefined) continue;
    for (const injection of injectionsIn(text)) if (changed.has(file) || ranLine(ranges, injection.line)) keys.add(injection.key);
  }
  return keys;
}

export function setupsFor(tests: readonly string[], runs: readonly Ran[], changed: ReadonlySet<string>, world: SetupWorld): string[] {
  const byTest = new Map<string, Ran[]>();
  for (const run of runs) byTest.set(run.testFile, [...(byTest.get(run.testFile) ?? []), run]);
  const wanted = new Set<string>();
  for (const test of tests) {
    const ran = byTest.get(test);
    const keys = ran && !changed.has(test) ? keysRanBy(test, ran, changed, world) : keysReachedFrom(test, world);
    for (const key of keys) {
      const setup = world.providers.get(key);
      if (setup) wanted.add(setup);
    }
  }
  return [...wanted].sort();
}
