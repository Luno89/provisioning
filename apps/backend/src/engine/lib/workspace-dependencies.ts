import { dependencyProblems, type Install, type WorkspaceDependency } from '@koala/agent-engine';
import { fieldsOf } from './request-fields.js';

const PACKAGE_MANAGERS = ['dnf', 'apt', 'pip', 'npm'] as const;

const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

function installFrom(value: unknown): Install | undefined {
  const fields = fieldsOf(value);
  if (fields.via === 'base') return { via: 'base' };
  if (fields.via === 'script') return typeof fields.run === 'string' ? { via: 'script', run: fields.run } : undefined;
  const via = PACKAGE_MANAGERS.find((manager) => manager === fields.via);
  return via && isTextList(fields.packages) ? { via, packages: fields.packages } : undefined;
}

function installsFrom(value: unknown, field: string): Install[] | string {
  if (!Array.isArray(value)) return `${field} has to be a list of installs`;
  const installs: Install[] = [];
  for (const entry of value) {
    const install = installFrom(entry);
    if (!install) return `every entry in ${field} is { via: dnf|apt|pip|npm, packages: [...] } or { via: script, run: "..." }`;
    installs.push(install);
  }
  return installs;
}

export type DependencyReading = { ok: true; dependency: WorkspaceDependency } | { ok: false; problem: string };

export function dependencyFrom(value: unknown): DependencyReading {
  const fields = fieldsOf(value);
  if (typeof fields.name !== 'string') return { ok: false, problem: 'a dependency needs a name' };
  if (fields.summary !== undefined && typeof fields.summary !== 'string') return { ok: false, problem: 'summary has to be text' };
  for (const list of ['provides', 'libraries', 'needs'] as const) {
    if (fields[list] !== undefined && !isTextList(fields[list])) return { ok: false, problem: `${list} has to be a list of names` };
  }
  const install = fields.install === undefined ? [] : installsFrom(fields.install, 'install');
  if (typeof install === 'string') return { ok: false, problem: install };
  const onDebian = fields.onDebian === undefined ? undefined : installsFrom(fields.onDebian, 'onDebian');
  if (typeof onDebian === 'string') return { ok: false, problem: onDebian };
  const provides = isTextList(fields.provides) ? fields.provides : [];
  const libraries = isTextList(fields.libraries) ? fields.libraries : undefined;
  const needs = isTextList(fields.needs) ? fields.needs : undefined;
  return {
    ok: true,
    dependency: {
      name: fields.name,
      summary: typeof fields.summary === 'string' ? fields.summary : '',
      provides,
      ...(libraries ? { libraries } : {}),
      ...(needs ? { needs } : {}),
      install,
      ...(onDebian ? { onDebian } : {}),
    },
  };
}

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
