import { dependencyProblems, type Install, type WorkspaceDependency } from '@koala/agent-engine';

export function catalogueOf(shipped: readonly WorkspaceDependency[], own: readonly WorkspaceDependency[]): WorkspaceDependency[] {
  const taken = new Set(shipped.map((dependency) => dependency.name));
  return [...shipped, ...own.filter((dependency) => !taken.has(dependency.name))];
}

export function unknownNeeds(needs: readonly string[] | undefined, catalogue: readonly Pick<WorkspaceDependency, 'name'>[]): string[] {
  const known = new Set(catalogue.map((dependency) => dependency.name));
  return [...new Set((needs ?? []).filter((need) => !known.has(need)))];
}

export const unknownNeedsSaid = (unknown: readonly string[], catalogue: readonly Pick<WorkspaceDependency, 'name'>[]): string =>
  `no dependency is called ${unknown.map((name) => `"${name}"`).join(', ')}; there are ${catalogue.map((dependency) => dependency.name).sort().join(', ')}, or add one of your own`;

function reaches(from: string, to: string, catalogue: readonly WorkspaceDependency[], seen = new Set<string>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const dependency = catalogue.find((entry) => entry.name === from);
  return (dependency?.needs ?? []).some((next) => reaches(next, to, catalogue, seen));
}

export function ownDependencyProblems(dependency: WorkspaceDependency, shipped: readonly WorkspaceDependency[], own: readonly WorkspaceDependency[]): string[] {
  const problems = dependencyProblems(dependency);
  if (shipped.some((entry) => entry.name === dependency.name)) problems.push(`${dependency.name} is one Koala ships; pick another name for your own`);
  const others = catalogueOf(shipped, own.filter((entry) => entry.name !== dependency.name));
  const unknown = unknownNeeds(dependency.needs, others);
  if (unknown.length) problems.push(`${dependency.name} needs what does not exist: ${unknownNeedsSaid(unknown, others)}`);
  else if ((dependency.needs ?? []).some((need) => reaches(need, dependency.name, others))) problems.push(`${dependency.name} would end up needing itself`);
  return problems;
}

export function hasScript(dependency: Pick<WorkspaceDependency, 'install' | 'onDebian'>): boolean {
  return [...dependency.install, ...(dependency.onDebian ?? [])].some((install) => install.via === 'script');
}

export function dependencyFromInstall(name: string, summary: string, install: readonly Install[], provides: readonly string[]): WorkspaceDependency {
  return { name, summary, provides: [...provides], install: install.filter((step) => step.via !== 'base').map((step) => ({ ...step })) as Install[] };
}

export const dependencyNameFor = (raw: string): string =>
  raw.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^([^a-z])/, 'x-$1').slice(0, 40).replace(/-+$/, '') || 'dependency';
