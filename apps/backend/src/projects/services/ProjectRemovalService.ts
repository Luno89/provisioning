import type { Client } from '@temporalio/client';
import { type ProjectDeletionMode, type ProjectMetadata, type ProjectRemoval, allowed, asPerson, startedFor } from '../../platform/index.js';
import { PURGE_PROJECT_WORKFLOW, keptUntil, purgeNow, purgeProjectWorkflowId, restoreProject } from '../lib/project-archive.js';
import {
  DELETE_PROJECT_WORKFLOW,
  deleteProjectWorkflowId,
  projectRemovalPreview,
  projectRemovalScope,
  type ProjectRemovalPreview,
  type ProjectRemovalScope,
  type ProjectRemovalStep,
} from '../lib/project-removal.js';
import type { ProjectRemovalStore } from '../../activities/RemoveProjectActivities.js';
import type { ProjectsStore } from '../store.js';
import type { AccountRemovalWorkflows, RemovalWorkflowState } from '../../accounts/index.js';
import { withWorkFor } from '@koala/engine-core/work-for';

export type ProjectRemovalState = RemovalWorkflowState<ProjectRemovalStep>;

export interface LoadedProjectScope {
  project: ProjectMetadata;
  scope: ProjectRemovalScope;
}

export async function loadProjectScope(store: ProjectRemovalStore, projectId: string): Promise<LoadedProjectScope | undefined> {
  const project = (await store.projects.getProjects()).find((entry) => entry.id === projectId);
  if (!project) return undefined;
  const ownerId = project.ownerId ?? '';
  const [trees, branches, leaves, tasks, proposals, conversations, deployments, pipelineRuns] = await Promise.all([
    store.projects.getTrees(), store.projects.getBranches(), store.projects.getLeaves(), store.projects.getTasks(ownerId), store.projects.getPlanProposals(ownerId),
    store.engine.getConversations(), store.infrastructure.getDeployments(), store.releases.getPipelineRuns(),
  ]);
  const mine = <T extends { ownerId?: string | undefined }>(list: T[]) => list.filter((entry) => entry.ownerId === ownerId);
  const world = { trees, branches: mine(branches), leaves: mine(leaves), tasks, proposals, conversations: mine(conversations), deployments, pipelineRuns };
  return { project, scope: projectRemovalScope(project, world) };
}

export type ProjectRemovalRefusal =
  | { status: 404; error: string }
  | { status: 400; error: string };

export interface ProjectPurges {
  keptUntil(projectId: string): Promise<Date | undefined>;
  restore(projectId: string, ownerId: string): Promise<void>;
  now(projectId: string, ownerId: string): Promise<void>;
}

const notFound = (err: unknown): boolean => /not\s*found/i.test(String((err as Error)?.message ?? err));

export const temporalPurges = (client: () => Promise<Client>, taskQueue: string): ProjectPurges => {
  const wake = async (projectId: string, ownerId: string, how: typeof purgeNow): Promise<void> => {
    const temporal = await client();
    await withWorkFor({ project: projectId, removing: 'project' }, () => temporal.workflow.signalWithStart(PURGE_PROJECT_WORKFLOW, { ...how(projectId, taskQueue), ...startedFor(ownerId) }));
  };
  return {
    async keptUntil(projectId) {
      const described = await (await client()).workflow.getHandle(purgeProjectWorkflowId(projectId)).describe().catch((err: unknown) => {
        if (notFound(err)) return undefined;
        throw err;
      });
      return described?.status.name === 'RUNNING' ? keptUntil(described) : undefined;
    },
    restore: (projectId, ownerId) => wake(projectId, ownerId, restoreProject),
    now: (projectId, ownerId) => wake(projectId, ownerId, purgeNow),
  };
};

export interface DeletedProject {
  id: string;
  name: string;
  deletedAt: string;
  keptUntil: string | undefined;
}

type Refused = { ok: false; refusal: { status: 400 | 404 | 409; error: string } };

const NOT_FOUND: Refused = { ok: false, refusal: { status: 404, error: 'Project not found' } };

export interface ProjectRemovalDeps {
  store: ProjectRemovalStore & { projects: Pick<ProjectsStore, 'deletedProjects' | 'restore' | 'deletion'> };
  workflows: AccountRemovalWorkflows<{ projectId: string; mode: ProjectDeletionMode }, ProjectRemovalStep>;
  purges: ProjectPurges;
  now?: () => string;
}

export class ProjectRemovalService {
  constructor(private readonly deps: ProjectRemovalDeps) {}

  private async owned(ownerId: string, projectId: string): Promise<LoadedProjectScope | undefined> {
    const loaded = await loadProjectScope(this.deps.store, projectId);
    return loaded && allowed(asPerson(ownerId), 'change', { kind: 'project', ownerId: loaded.project.ownerId }) ? loaded : undefined;
  }

  async preview(ownerId: string, projectId: string): Promise<(ProjectRemovalPreview & { deletion?: ProjectRemoval }) | undefined> {
    const loaded = await this.owned(ownerId, projectId);
    if (!loaded) return undefined;
    const { removal } = loaded.project;
    return { ...projectRemovalPreview(loaded.project, loaded.scope), ...(removal ? { deletion: removal } : {}) };
  }

  async remove(ownerId: string, projectId: string, confirm: string, mode: ProjectDeletionMode): Promise<{ ok: true; deletion: ProjectRemoval } | { ok: false; refusal: ProjectRemovalRefusal }> {
    const loaded = await this.owned(ownerId, projectId);
    if (!loaded) return { ok: false, refusal: { status: 404, error: 'Project not found' } };
    if (confirm.trim() !== loaded.project.name) return { ok: false, refusal: { status: 400, error: `Type the project's name, ${loaded.project.name}, to confirm` } };

    const { projects } = this.deps.store;
    await projects.markDeleting(projectId, { startedAt: this.deps.now?.() ?? new Date().toISOString(), requestedBy: ownerId, mode });
    const marked = await projects.deletion(projectId);
    if (!marked) return { ok: false, refusal: { status: 404, error: 'Project not found' } };
    if (marked.phase === 'archived') return { ok: true, deletion: marked };
    const workflowId = deleteProjectWorkflowId(projectId);
    if ((await this.deps.workflows.state(workflowId)).state === 'running') return { ok: true, deletion: marked };
    await withWorkFor({ project: projectId, removing: 'project' }, () => this.deps.workflows.start(DELETE_PROJECT_WORKFLOW, workflowId, [{ projectId, mode: marked.mode }], loaded.project.ownerId ?? ownerId));
    return { ok: true, deletion: marked };
  }

  async deleted(ownerId: string): Promise<DeletedProject[]> {
    const kept = await this.deps.store.projects.deletedProjects(ownerId);
    return Promise.all(kept.map(async (project) => ({
      id: project.id,
      name: project.name,
      deletedAt: project.removal?.startedAt ?? project.createdAt,
      keptUntil: (await this.deps.purges.keptUntil(project.id))?.toISOString(),
    })));
  }

  private async kept(ownerId: string, projectId: string): Promise<{ ok: true; project: ProjectMetadata } | Refused> {
    const loaded = await this.owned(ownerId, projectId);
    if (!loaded) return NOT_FOUND;
    if (loaded.project.removal?.phase !== 'archived') return { ok: false, refusal: { status: 409, error: 'Only a deleted project kept for its 90 days can be restored' } };
    return { ok: true, project: loaded.project };
  }

  async restore(ownerId: string, projectId: string): Promise<{ ok: true; name: string; renamed: boolean } | Refused> {
    const kept = await this.kept(ownerId, projectId);
    if (!kept.ok) return kept;
    const { project } = kept;
    const taken = (await this.deps.store.projects.getProjects()).some((other) => other.id !== project.id && other.ownerId === project.ownerId && !other.removal && other.name === project.name);
    const name = taken ? `${project.name} (restored)` : project.name;
    await this.deps.purges.restore(projectId, project.ownerId ?? ownerId);
    await this.deps.store.projects.restore(projectId, name);
    return { ok: true, name, renamed: taken };
  }

  async purgeNow(ownerId: string, projectId: string, confirm: string): Promise<{ ok: true } | Refused> {
    const kept = await this.kept(ownerId, projectId);
    if (!kept.ok) return kept;
    if (confirm.trim() !== kept.project.name) return { ok: false, refusal: { status: 400, error: `Type the project's name, ${kept.project.name}, to confirm` } };
    await this.deps.purges.now(projectId, kept.project.ownerId ?? ownerId);
    return { ok: true };
  }
}
