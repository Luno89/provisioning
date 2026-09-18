import { createHash } from 'crypto';
import { environmentFor, type AgentDefinition } from '../agent/agent.js';
import type { Install, ToolDefinition } from '../tools/catalogue.js';

export interface ImagePlan {
  base: string;
  installs: Install[];
  provides: string[];
  fingerprint: string;
}

export interface BaseImage {
  id: string;
  image: string;
  provides: string[];
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
  },
  {
    id: 'python',
    image: 'registry.access.redhat.com/ubi9/python-312',
    provides: ['bash', 'git', 'python3', 'pip', 'venv', 'node', 'npm', 'gcc', 'make', 'curl', 'wget', 'tar'],
  },
  {
    id: 'go',
    image: 'registry.access.redhat.com/ubi9/go-toolset',
    provides: ['bash', 'git', 'go', 'node', 'npm', 'python3', 'gcc', 'make', 'curl', 'wget', 'tar'],
  },
];

export const DEFAULT_BASE = 'node';

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
  tools: readonly ToolDefinition[];
}): ImagePlan {
  const base = BASES.find((candidate) => candidate.id === (input.base ?? DEFAULT_BASE));
  if (!base) throw new UnbuildableError(`There is no base image called "${input.base}"`);

  const provides = new Set(base.provides);
  const installs: Install[] = [];

  for (const tool of input.tools) {
    if (tool.binding !== 'environment') continue;

    const missing = (tool.needsBinaries ?? []).filter((binary) => !provides.has(binary));
    if (missing.length === 0) continue;

    if (!tool.install || tool.install.via === 'base') {
      throw new UnbuildableError(
        `${tool.name} needs ${missing.join(', ')}, which ${base.image} does not have, and it does not say how to install it`,
      );
    }

    installs.push(tool.install);
    for (const binary of tool.needsBinaries ?? []) provides.add(binary);
    for (const binary of tool.provides ?? []) provides.add(binary);
  }

  return {
    base: base.image,
    installs,
    provides: [...provides].sort(),
    fingerprint: fingerprint(base.image, installs),
  };
}

const RUN_FOR: Record<Exclude<Install['via'], 'script' | 'base'>, (packages: string[]) => string> = {
  dnf: (packages) => `microdnf install -y ${packages.join(' ')} && microdnf clean all`,
  apt: (packages) => `apt-get update && apt-get install -y --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`,
  pip: (packages) => `pip install --no-cache-dir ${packages.join(' ')}`,
  npm: (packages) => `npm install -g ${packages.join(' ')}`,
};

export function renderDockerfile(plan: ImagePlan): string {
  const lines = [`FROM ${plan.base}`, 'USER root'];

  for (const install of plan.installs) {
    if (install.via === 'base') continue;
    lines.push(`RUN ${install.via === 'script' ? install.run : RUN_FOR[install.via](install.packages)}`);
  }

  lines.push('USER 1000');
  return `${lines.join('\n')}\n`;
}

export function imageReference(registry: string, plan: ImagePlan): string {
  return `${registry}/koala/workspace:${plan.fingerprint}`;
}

export function needsBuilding(plan: ImagePlan): boolean {
  return plan.installs.length > 0;
}

export function imageFor(registry: string, plan: ImagePlan): string {
  return needsBuilding(plan) ? imageReference(registry, plan) : plan.base;
}

export function baseFor(agent: Pick<AgentDefinition, 'environmentSpec' | 'environment'>): string {
  return agent.environmentSpec?.languages?.[0]
    ?? agent.environment.languages?.[0]
    ?? DEFAULT_BASE;
}

export function planFor(
  agent: AgentDefinition,
  catalogue: readonly ToolDefinition[],
): ImagePlan | undefined {
  if (environmentFor(agent).kind !== 'sandbox') return undefined;

  const granted = new Set(agent.tools);
  return planImage({
    base: baseFor(agent),
    tools: catalogue.filter((tool) => granted.has(tool.name)),
  });
}
