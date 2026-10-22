import { HOST_OP_KIND, type Procedure } from '@koala/agent-engine/procedure';
import type { ProjectMetadata } from '../../platform/lib/types.js';
import type { TreeTypeSpec } from '../../projects/lib/tree-types.js';
import { IMAGE_ONLY_STEPS, OPEN_STEP, RELEASE_APPS, RELEASE_STEP, releaseHowOf, releaseHowProblem, type ReleaseApp, type ReleaseHow } from '../lib/release-run.js';

export interface ReleaseAgent {
  slug: string;
  name: string;
  description?: string | undefined;
  needsApp: boolean;
}

export interface ReleaseSettingsDeps {
  agents: (ownerId: string) => Promise<{ slug: string; name: string; description?: string | undefined }[]>;
  procedureOf: (ownerId: string, slug: string) => Promise<Procedure | undefined>;
  treeTypes: (ownerId: string) => Promise<TreeTypeSpec[]>;
  saveTreeType: (type: TreeTypeSpec) => Promise<void>;
  projects: () => Promise<ProjectMetadata[]>;
  saveProject: (project: ProjectMetadata) => Promise<unknown>;
  typeOfProject: (project: ProjectMetadata) => Promise<TreeTypeSpec | undefined>;
  hasChart: (project: ProjectMetadata) => Promise<boolean>;
}

export type Settled<T> = { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

const releaseSteps = (procedure: Procedure | undefined): string[] =>
  (procedure?.nodes ?? []).flatMap((node) => {
    const operation = node.kind === HOST_OP_KIND ? (node.settings as { operation?: unknown }).operation : undefined;
    return typeof operation === 'string' && operation.startsWith(RELEASE_STEP) ? [operation] : [];
  });

export type ReleaseAgentSource = Pick<ReleaseSettingsDeps, 'agents' | 'procedureOf'>;

export async function releaseAgentsOf(source: ReleaseAgentSource, ownerId: string): Promise<ReleaseAgent[]> {
  const found: ReleaseAgent[] = [];
  for (const agent of await source.agents(ownerId)) {
    const steps = releaseSteps(await source.procedureOf(ownerId, agent.slug));
    const beside = steps.includes(OPEN_STEP);
    if (!beside && !steps.some((step) => IMAGE_ONLY_STEPS.includes(step))) continue;
    found.push({ slug: agent.slug, name: agent.name, ...(agent.description ? { description: agent.description } : {}), needsApp: beside });
  }
  return found.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function releaseProblemOf(source: ReleaseAgentSource, ownerId: string, how: unknown): Promise<string | null> {
  const shape = releaseHowProblem(how);
  if (shape) return shape;
  const { agent, app } = how as ReleaseHow;
  const found = (await releaseAgentsOf(source, ownerId)).find((candidate) => candidate.slug === agent);
  if (!found) return `${agent} is not an agent that releases builds`;
  if (found.needsApp && !app) return `${agent} releases beside the live app, so it needs the app's adapter (${RELEASE_APPS.map((entry) => entry.id).join(', ')})`;
  if (!found.needsApp && app) return `${agent} replaces the running app, so it takes no app adapter`;
  if (app && !RELEASE_APPS.some((entry) => entry.id === app)) return `there is no release adapter called ${app} (there are ${RELEASE_APPS.map((entry) => entry.id).join(', ')})`;
  return null;
}

export class ReleaseSettings {
  constructor(private readonly deps: ReleaseSettingsDeps) {}

  agents(ownerId: string): Promise<ReleaseAgent[]> {
    return releaseAgentsOf(this.deps, ownerId);
  }

  async options(ownerId: string): Promise<{ agents: ReleaseAgent[]; apps: readonly ReleaseApp[] }> {
    return { agents: await this.agents(ownerId), apps: RELEASE_APPS };
  }

  problem(ownerId: string, how: unknown): Promise<string | null> {
    return releaseProblemOf(this.deps, ownerId, how);
  }

  async setForType(ownerId: string, typeId: string, how: unknown): Promise<Settled<TreeTypeSpec>> {
    const type = (await this.deps.treeTypes(ownerId)).find((entry) => entry.id === typeId);
    if (!type) return { ok: false, status: 404, error: `there is no tree type ${typeId}` };
    if (how !== undefined) {
      const problem = await this.problem(ownerId, how);
      if (problem) return { ok: false, status: 400, error: problem };
    }
    const { release: _release, ...rest } = type;
    const next: TreeTypeSpec = { ...rest, ownerId, ...(how !== undefined ? { release: how as ReleaseHow } : {}) };
    await this.deps.saveTreeType(next);
    return { ok: true, value: next };
  }

  async ofProject(ownerId: string, projectId: string): Promise<Settled<{ how: ReleaseHow; from: 'project' | 'tree type' | 'repository' }>> {
    const project = (await this.deps.projects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };
    const type = await this.deps.typeOfProject(project);
    const how = releaseHowOf(project, type, await this.deps.hasChart(project));
    const from = project.release?.agent ? 'project' : type?.release?.agent ? 'tree type' : 'repository';
    return { ok: true, value: { how, from } };
  }

  async setForProject(ownerId: string, projectId: string, how: unknown): Promise<Settled<{ how: ReleaseHow; from: 'project' | 'tree type' | 'repository' }>> {
    const project = (await this.deps.projects()).find((entry) => entry.id === projectId && entry.ownerId === ownerId);
    if (!project) return { ok: false, status: 404, error: 'Project not found' };
    if (how !== undefined) {
      const problem = await this.problem(ownerId, how);
      if (problem) return { ok: false, status: 400, error: problem };
    }
    const { release: _release, ...rest } = project;
    await this.deps.saveProject({ ...rest, ...(how !== undefined ? { release: how as ReleaseHow } : {}) });
    return this.ofProject(ownerId, projectId);
  }
}
