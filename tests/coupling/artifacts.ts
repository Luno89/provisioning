import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const OUT = join(ROOT, 'tests', '.coupling');

export type Artifact = 'in-process';
export const ARTIFACTS: readonly Artifact[] = ['in-process'];

export interface Timing { seconds: number; plainSeconds?: number; passed: boolean }

export interface Gathered {
  artifact: Artifact;
  source: string;
  commit: string;
  at: string;
  workspaces: string[];
  complete: boolean;
  timings: Record<string, Timing>;
}

const SOURCE_PATHS = ['apps', 'packages', 'scripts', 'charts'];

const git = (root: string, args: readonly string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

export const commitOf = (root = ROOT): string => git(root, ['rev-parse', '--short=12', 'HEAD']).trim();

export function sourceOf(root = ROOT): string {
  const hash = createHash('sha256');
  hash.update(git(root, ['rev-parse', ...SOURCE_PATHS.map((path) => `HEAD:${path}`)]));
  hash.update(git(root, ['diff', 'HEAD', '--', ...SOURCE_PATHS]));
  for (const file of git(root, ['ls-files', '--others', '--exclude-standard', '--', ...SOURCE_PATHS]).split('\n').filter(Boolean)) {
    hash.update(file).update(readFileSync(join(root, file)));
  }
  return hash.digest('hex').slice(0, 16);
}

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

export interface Usable { artifacts: Set<Artifact>; problems: string[] }

export function usableIn(gathered: Partial<Record<Artifact, Gathered>>, source: string): Usable {
  const artifacts = new Set<Artifact>();
  const problems: string[] = [];
  for (const artifact of ARTIFACTS) {
    const entry = gathered[artifact];
    if (!entry) continue;
    if (entry.source !== source) problems.push(`${artifact} was gathered from other code (${entry.commit}, ${entry.at}): gather it again`);
    else if (!entry.complete) problems.push(`${artifact} was gathered for ${entry.workspaces.join(', ')} only, so it judges nothing`);
    else {
      const failed = Object.entries(entry.timings).filter(([, timing]) => !timing.passed).map(([name]) => name);
      if (failed.length > 0) problems.push(`${artifact}: ${failed.join(', ')} failed while gathering, so it judges nothing`);
      else artifacts.add(artifact);
    }
  }
  return { artifacts, problems };
}
