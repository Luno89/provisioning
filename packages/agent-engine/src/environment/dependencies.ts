import type { Install } from '../tools/catalogue.js';

export interface WorkspaceDependency {
  name: string;
  summary: string;
  provides: string[];
  libraries?: string[] | undefined;
  needs?: string[] | undefined;
  install: Install[];
  onDebian?: Install[] | undefined;
  ownerId?: string | undefined;
}

export interface Need {
  name: string;
  from: string;
}

export const DEPENDENCY_NAME = /^[a-z][a-z0-9-]{0,39}$/;

export const LANGUAGE_DEPENDENCIES: WorkspaceDependency[] = [
  { name: 'node', summary: 'Node.js and npm.', provides: ['node', 'npm'], install: [{ via: 'dnf', packages: ['nodejs', 'npm'] }] },
  { name: 'python', summary: 'Python 3 and pip.', provides: ['python3', 'pip'], install: [{ via: 'dnf', packages: ['python3', 'python3-pip'] }] },
  { name: 'go', summary: 'The Go toolchain.', provides: ['go'], install: [{ via: 'dnf', packages: ['go-toolset'] }] },
];

export const LANGUAGE_IDS: string[] = LANGUAGE_DEPENDENCIES.map((dependency) => dependency.name);

export const MANAGER_NEEDS: Readonly<Partial<Record<Install['via'], string>>> = { pip: 'python', npm: 'node' };

export function dependencyProblems(dependency: Partial<WorkspaceDependency>): string[] {
  const problems: string[] = [];
  const name = dependency.name ?? '';
  if (!DEPENDENCY_NAME.test(name)) problems.push(`"${name}" is not a dependency name: lower-case letters, digits and dashes, starting with a letter`);
  if (!dependency.summary?.trim()) problems.push(`${name || 'a dependency'} needs a one-line summary of what it gives a workspace`);
  if (!dependency.provides?.length && !dependency.libraries?.length) problems.push(`${name || 'a dependency'} has to say which programs it puts on the PATH, or which libraries it adds, so a build can prove it did`);
  if (!Array.isArray(dependency.install) || dependency.install.length === 0) problems.push(`${name || 'a dependency'} has to say how it is installed`);
  for (const install of [...(dependency.install ?? []), ...(dependency.onDebian ?? [])]) {
    if (install.via === 'base') problems.push(`${name} cannot install "nothing"; a base image that already has it says so itself`);
    else if (install.via === 'script' ? !install.run.trim() : install.packages.length === 0) problems.push(`${name} has an install that installs nothing`);
  }
  for (const need of dependency.needs ?? []) if (need === name) problems.push(`${name} cannot need itself`);
  return problems;
}

export class UnknownDependencyError extends Error {
  constructor(readonly names: string[], readonly known: string[], readonly wantedBy: string) {
    super(`${wantedBy} needs ${names.map((name) => `"${name}"`).join(', ')}, which no dependency is called; the workspace can have ${known.join(', ')}`);
    this.name = 'UnknownDependencyError';
  }
}

export class DependencyCycleError extends Error {
  constructor(readonly path: string[]) {
    super(`these dependencies need each other in a circle: ${path.join(' → ')}`);
    this.name = 'DependencyCycleError';
  }
}

export interface ResolvedDependency {
  dependency: WorkspaceDependency;
  from: string;
}

export function resolveNeeds(
  needs: readonly Need[],
  catalogue: readonly WorkspaceDependency[],
  has: Set<string>,
  provides: Set<string>,
): ResolvedDependency[] {
  const byName = new Map(catalogue.map((dependency) => [dependency.name, dependency]));
  const known = [...byName.keys()].sort();
  const placed = new Set<string>();
  const resolved: ResolvedDependency[] = [];

  const visit = (name: string, from: string, path: readonly string[]): void => {
    if (placed.has(name)) return;
    if (path.includes(name)) throw new DependencyCycleError([...path, name]);
    const dependency = byName.get(name);
    if (!dependency) throw new UnknownDependencyError([name], known, path.length ? path[path.length - 1]! : from);
    const managers = dependency.install.flatMap((install) => (MANAGER_NEEDS[install.via] && MANAGER_NEEDS[install.via] !== name ? [MANAGER_NEEDS[install.via]!] : []));
    for (const inner of new Set([...(dependency.needs ?? []), ...managers])) visit(inner, from, [...path, name]);
    placed.add(name);
    if (has.has(name) || (dependency.provides.length > 0 && dependency.provides.every((binary) => provides.has(binary)))) return;
    resolved.push({ dependency, from });
    has.add(name);
    for (const binary of dependency.provides) provides.add(binary);
  };

  const unknown = needs.filter((need) => !byName.has(need.name));
  if (unknown.length) throw new UnknownDependencyError([...new Set(unknown.map((need) => need.name))], known, unknown[0]!.from);
  for (const need of needs) visit(need.name, need.from, []);
  return resolved;
}
