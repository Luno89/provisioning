import { createHash } from 'crypto';
import { environmentFor, type AgentDefinition } from '../agent/agent.js';
import type { Install, ToolDefinition } from '../tools/catalogue.js';
import { DependencyCycleError, LANGUAGE_DEPENDENCIES, LANGUAGE_IDS, MANAGER_NEEDS, UnknownDependencyError, isPackageName, resolveNeeds, type Need, type PackageManager, type WorkspaceDependency } from './dependencies.js';

export interface ImagePlan {
  base: string;
  installs: Install[];
  provides: string[];
  fingerprint: string;
  has?: string[] | undefined;
  env?: { name: string; value: string }[] | undefined;
  lines?: PlanLine[] | undefined;
  proves?: DependencyProof[] | undefined;
  contents?: ImageContent[] | undefined;
}

export interface ImageContent {
  dependency: string;
  why: string[];
  installed: boolean;
}

export interface DependencyProof {
  dependency: string;
  programs: string[];
  libraries: string[];
}

export interface PlanLine {
  install: Install;
  from: string;
  dependency?: string | undefined;
  own?: true | undefined;
}

export interface Contribution {
  from: string;
  install: Install;
  provides?: readonly string[] | undefined;
}

export interface BaseImage {
  id: string;
  image: string;
  provides: string[];
  has?: string[] | undefined;
  family?: 'debian' | undefined;
  setup?: Install[] | undefined;
  env?: { name: string; value: string }[] | undefined;
}

export const BASES: BaseImage[] = [
  {
    id: 'minimal',
    image: 'registry.access.redhat.com/ubi9/ubi-minimal',
    provides: ['sh', 'curl', 'tar'],
  },
  {
    id: 'node',
    image: 'registry.access.redhat.com/ubi9/nodejs-22',
    provides: ['bash', 'git', 'node', 'npm', 'npx', 'python3', 'gcc', 'make', 'curl', 'tar'],
    has: ['node'],
  },
  {
    id: 'python',
    image: 'registry.access.redhat.com/ubi9/python-312',
    provides: ['bash', 'git', 'python3', 'pip', 'venv', 'node', 'npm', 'gcc', 'make', 'curl', 'wget', 'tar'],
    has: ['python', 'node'],
  },
  {
    id: 'go',
    image: 'registry.access.redhat.com/ubi9/go-toolset',
    provides: ['bash', 'git', 'go', 'node', 'npm', 'python3', 'gcc', 'make', 'curl', 'wget', 'tar'],
    has: ['go', 'node'],
  },
];

export const DEFAULT_BASE = 'node';

export { LANGUAGE_IDS };

export class UnbuildableError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnbuildableError';
  }
}

function stable(installs: readonly Install[]): string {
  return JSON.stringify(
    installs
      .map((install) => (install.via === 'script'
        ? { via: install.via, run: install.run }
        : install.via === 'base'
          ? { via: install.via }
          : { via: install.via, packages: [...install.packages].sort() }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  );
}

export function fingerprint(base: string, installs: readonly Install[]): string {
  return createHash('sha256')
    .update(`${base}\n${stable(installs)}`)
    .digest('hex')
    .slice(0, 32);
}

export function planImage(input: {
  base?: string | undefined;
  languages?: readonly string[] | undefined;
  tools: readonly ToolDefinition[];
  needs?: readonly Need[] | undefined;
  contributions?: readonly Contribution[] | undefined;
  bases?: readonly BaseImage[] | undefined;
  dependencies?: readonly WorkspaceDependency[] | undefined;
}): ImagePlan {
  const base = (input.bases ?? BASES).find((candidate) => candidate.id === (input.base ?? DEFAULT_BASE));
  if (!base) throw new UnbuildableError(`There is no base image called "${input.base}"`);

  const provides = new Set(base.provides);
  const has = new Set([...(base.has ?? []), base.id]);
  const lines: PlanLine[] = (base.setup ?? []).map((install) => ({ install, from: `base:${base.id}` }));
  const contributions = (input.contributions ?? []).filter((contribution) => contribution.install.via !== 'base'
    && !(contribution.provides?.length && contribution.provides.every((binary) => provides.has(binary))));

  const catalogue = input.dependencies ?? LANGUAGE_DEPENDENCIES;
  const needs: Need[] = [
    ...(input.languages ?? [])
      .filter((name) => !(name === base.id || ((input.bases ?? BASES).some((candidate) => candidate.id === name) && !catalogue.some((dependency) => dependency.name === name))))
      .map((name) => ({ name, from: `language:${name}` })),
    ...input.tools.filter((tool) => tool.binding === 'environment').flatMap((tool) => (tool.needs ?? []).map((name) => ({ name, from: `tool:${tool.name}` }))),
    ...(input.needs ?? []),
    ...contributions.flatMap((contribution) => {
      const manager = MANAGER_NEEDS[contribution.install.via];
      return manager ? [{ name: manager, from: contribution.from }] : [];
    }),
  ];

  let resolved;
  const why = new Map<string, Set<string>>();
  try {
    resolved = resolveNeeds(needs, catalogue, has, provides, why);
  } catch (err) {
    if (err instanceof UnknownDependencyError || err instanceof DependencyCycleError) throw new UnbuildableError(err.message);
    throw err;
  }
  for (const { dependency, from } of resolved) {
    const installs = base.family === 'debian' && dependency.onDebian?.length ? dependency.onDebian : dependency.install;
    for (const install of installs) lines.push({ install, from, dependency: dependency.name, ...(dependency.ownerId ? { own: true as const } : {}) });
  }
  for (const contribution of contributions) {
    lines.push({ install: contribution.install, from: contribution.from });
    for (const binary of contribution.provides ?? []) provides.add(binary);
  }

  const installs = lines.map((line) => line.install);
  const proves = resolved.map(({ dependency }) => ({ dependency: dependency.name, programs: [...dependency.provides], libraries: [...(dependency.libraries ?? [])] }));
  const installed = new Set(resolved.map(({ dependency }) => dependency.name));
  const contents: ImageContent[] = [
    ...resolved.map(({ dependency }) => dependency.name),
    ...[...why.keys()].filter((name) => !installed.has(name)).sort(),
  ].map((name) => ({ dependency: name, why: [...(why.get(name) ?? [])].sort(), installed: installed.has(name) }));
  return {
    base: base.image,
    installs,
    lines,
    provides: [...provides].sort(),
    has: [...has].sort(),
    ...(proves.length ? { proves } : {}),
    ...(contents.length ? { contents } : {}),
    fingerprint: fingerprint(base.image, installs),
    ...(base.env?.length ? { env: base.env.map((entry) => ({ ...entry })) } : {}),
  };
}

export const APT_NAMES: Readonly<Record<string, string>> = { 'go-toolset': 'golang-go' };

const quoted = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const named = (manager: PackageManager, packages: readonly string[]): string => packages.map((name) => {
  if (!isPackageName(manager, name)) throw new Error(`"${name}" is not a ${manager} package name, so it is never put in a build`);
  return quoted(name);
}).join(' ');

const onApt = (packages: readonly string[]): string => named('apt', packages.map((name) => APT_NAMES[name] ?? name));

const RUN_FOR: Record<PackageManager, (packages: string[]) => string> = {
  dnf: (packages) => `if command -v microdnf >/dev/null 2>&1; then microdnf install -y ${named('dnf', packages)} && microdnf clean all; elif command -v dnf >/dev/null 2>&1; then dnf install -y ${named('dnf', packages)} && dnf clean all; else apt-get update && apt-get install -y --no-install-recommends ${onApt(packages)} && rm -rf /var/lib/apt/lists/*; fi`,
  apt: (packages) => `apt-get update && apt-get install -y --no-install-recommends ${named('apt', packages)} && rm -rf /var/lib/apt/lists/*`,
  pip: (packages) => `PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --no-cache-dir ${named('pip', packages)}`,
  npm: (packages) => `npm install -g ${named('npm', packages)}`,
};

export function renderDockerfile(plan: ImagePlan): string {
  const lines = [`FROM ${plan.base}`, 'USER root'];

  for (const install of plan.installs) {
    if (install.via === 'base') continue;
    lines.push(`RUN ${install.via === 'script' ? install.run : RUN_FOR[install.via](install.packages)}`);
  }

  lines.push('USER 1000');
  if (plan.proves?.length) lines.push(`RUN ${proofScript(plan.proves)}`);
  return `${lines.join('\n')}\n`;
}

export function proofScript(proves: readonly DependencyProof[]): string {
  const checks = proves.flatMap((proof) => [
    ...proof.programs.map((program) => `command -v ${quoted(program)} >/dev/null 2>&1 || missing="$missing ${proof.dependency}:${program}"`),
    ...proof.libraries.map((library) => `{ ldconfig -p 2>/dev/null | grep -qF ${quoted(library)} || ls /usr/lib*/${quoted(library)}* /usr/lib*/*/${quoted(library)}* >/dev/null 2>&1; } || missing="$missing ${proof.dependency}:${library}"`),
  ]);
  return [
    'missing=""',
    ...checks,
    'if [ -n "$missing" ]; then for gap in $missing; do echo "the dependency ${gap%%:*} said it puts ${gap#*:} in the workspace, and once it was installed ${gap#*:} is not there" >&2; done; exit 1; fi',
  ].join('; ');
}

export const WORKSPACE_IMAGE = 'workspace';

export function imageReference(registry: string, plan: ImagePlan, owner = 'koala'): string {
  return `${registry}/${owner}/${WORKSPACE_IMAGE}:${plan.fingerprint}`;
}

export function needsBuilding(plan: ImagePlan): boolean {
  return plan.installs.length > 0;
}

export function imageFor(registry: string, plan: ImagePlan): string {
  return needsBuilding(plan) ? imageReference(registry, plan) : plan.base;
}

export function languagesFor(agent: Pick<AgentDefinition, 'environmentSpec' | 'environment'>): string[] {
  return [...(agent.environmentSpec?.languages ?? agent.environment.languages ?? [])];
}

export function baseFor(agent: Pick<AgentDefinition, 'environmentSpec' | 'environment'>, bases: readonly BaseImage[] = BASES): string {
  const languages = languagesFor(agent);
  const setUp = languages.find((language) => bases.some((base) => base.id === language && base.setup?.length));
  if (setUp) return setUp;
  const first = languages[0];
  return first && bases.some((base) => base.id === first) ? first : DEFAULT_BASE;
}

export function planFor(
  agent: AgentDefinition,
  catalogue: readonly ToolDefinition[],
  bases: readonly BaseImage[] = BASES,
  contributions: readonly Contribution[] = [],
  extra: { needs?: readonly Need[] | undefined; dependencies?: readonly WorkspaceDependency[] | undefined } = {},
): ImagePlan | undefined {
  if (environmentFor(agent).kind !== 'sandbox') return undefined;

  const granted = new Set(agent.tools);
  return planImage({
    base: baseFor(agent, bases),
    languages: languagesFor(agent),
    tools: catalogue.filter((tool) => granted.has(tool.name)),
    needs: [...(agent.needsFrom?.length ? agent.needsFrom : (agent.needs ?? []).map((name) => ({ name, from: `agent:${agent.slug}` }))), ...(extra.needs ?? [])],
    contributions,
    bases,
    ...(extra.dependencies ? { dependencies: extra.dependencies } : {}),
  });
}
