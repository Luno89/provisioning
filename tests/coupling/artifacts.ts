import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Ran } from './collect.js';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const OUT = join(ROOT, 'tests', '.coupling');

export type Artifact = 'in-process' | 'live';
export const ARTIFACTS: readonly Artifact[] = ['in-process', 'live'];

export interface Timing { seconds: number; plainSeconds?: number; passed: boolean }

export interface Gathered {
  artifact: Artifact;
  source: string;
  commit: string;
  at: string;
  workspaces: string[];
  complete: boolean;
  timings: Record<string, Timing>;
  files?: Record<string, string> | undefined;
}

const SOURCE_PATHS = ['apps', 'packages', 'scripts', 'charts'];

export const HASHED_PATHS = ['apps', 'packages', 'scripts', 'charts', 'tests', 'package.json', 'dependencies.pins.json'];

const git = (root: string, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

export const commitOf = (root = ROOT): string => git(root, ['rev-parse', '--short=12', 'HEAD']).trim();

export const keptAcrossGathers = (root = ROOT): string => join(resolve(root, git(root, ['rev-parse', '--git-common-dir']).trim()), 'koala-coupling');

export type SourceScope = 'all' | 'production';

const NOT_PRODUCTION = [':(exclude,glob)**/*.test.ts', ':(exclude,glob)**/*.test.tsx', ':(exclude,glob)**/*.test.mjs', ':(exclude,glob)**/testing/**'];

export function sourceOf(root = ROOT, scope: SourceScope = 'all', within: readonly string[] = SOURCE_PATHS): string {
  const hash = createHash('sha256');
  const paths = scope === 'all' ? within : [...within, ...NOT_PRODUCTION];
  hash.update(scope === 'all' ? git(root, ['rev-parse', ...within.map((path) => `HEAD:${path}`)]) : git(root, ['ls-files', '-s', '--', ...paths]));
  hash.update(git(root, ['diff', 'HEAD', '--', ...paths]));
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths]).split('\n').filter(Boolean)) {
    hash.update(file).update(readFileSync(join(root, file)));
  }
  return hash.digest('hex').slice(0, 16);
}

export const SCOPE_OF: Record<Artifact, SourceScope> = { 'in-process': 'all', live: 'production' };

export const runsOf = (out: string, artifact: Artifact): string => join(out, artifact, 'runs');
const gatheredFile = (out: string, artifact: Artifact): string => join(out, artifact, 'gathered.json');

export function gatheredIn(out: string): Partial<Record<Artifact, Gathered>> {
  const found: Partial<Record<Artifact, Gathered>> = {};
  for (const artifact of ARTIFACTS) {
    const file = gatheredFile(out, artifact);
    if (existsSync(file)) found[artifact] = JSON.parse(readFileSync(file, 'utf8')) as Gathered;
  }
  return found;
}

export function record(out: string, gathered: Gathered): void {
  mkdirSync(join(out, gathered.artifact), { recursive: true });
  writeFileSync(gatheredFile(out, gathered.artifact), `${JSON.stringify(gathered, null, 1)}\n`);
}

export function judgedGather(artifact: Artifact, held: { runs: boolean; gathered: Gathered | undefined }): Gathered | undefined {
  if (held.runs && !held.gathered) throw new Error(`${artifact} holds coverage runs with no record of their gather, so that gather stopped before it finished (the code changed while it ran, or it was stopped) and its runs belong to no commit: run npm run test:integration:coupled again`);
  if (!held.runs && held.gathered) throw new Error(`${artifact} has a record of its gather from ${held.gathered.commit} but no runs: gather it again`);
  return held.gathered;
}

export interface Usable { artifacts: Set<Artifact>; problems: string[] }

export function usableIn(gathered: Partial<Record<Artifact, Gathered>>, sources: Record<SourceScope, string>): Usable {
  const artifacts = new Set<Artifact>();
  const problems: string[] = [];
  for (const artifact of ARTIFACTS) {
    const entry = gathered[artifact];
    if (!entry) continue;
    if (entry.source !== sources[SCOPE_OF[artifact]]) problems.push(`${artifact} was gathered from other code (${entry.commit}, ${entry.at}): gather it again`);
    else if (!entry.complete) problems.push(`${artifact} was gathered for ${entry.workspaces.join(', ')} only, so it judges nothing`);
    else {
      const failed = Object.entries(entry.timings).filter(([, timing]) => !timing.passed).map(([name]) => name);
      if (failed.length > 0) problems.push(`${artifact}: ${failed.join(', ')} failed while gathering, so it judges nothing`);
      else artifacts.add(artifact);
    }
  }
  return { artifacts, problems };
}

export function runsIn(dir: string): Ran[] {
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')) as Ran);
}
