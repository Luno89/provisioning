import type { ProjectMetadata } from '../../platform/lib/types.js';
import {
  REMOVE_PROJECT_WORKFLOW,
  projectRemovalPreview,
  projectRemovalScope,
  removeProjectWorkflowId,
  type ProjectRemovalPreview,
  type ProjectRemovalScope,
  type ProjectRemovalStep,
} from '../lib/project-removal.js';
import type { ProjectRemovalStore } from '../../activities/RemoveProjectActivities.js';
import type { AccountRemovalWorkflows, RemovalWorkflowState } from '../../accounts/services/AccountRemovalService.js';

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
    store.getConversations(), store.infrastructure.getDeployments(), store.releases.getPipelineRuns(),
  ]);
  const mine = <T extends { ownerId?: string | undefined }>(list: T[]) => list.filter((entry) => entry.ownerId === ownerId);
  const world = { trees, branches: mine(branches), leaves: mine(leaves), tasks, proposals, conversations: mine(conversations), deployments, pipelineRuns };
  return { project, scope: projectRemovalScope(project, world) };
}

export type ProjectRemovalRefusal =
  | { status: 404; error: string }
  | { status: 400; error: string };

export interface ProjectRemovalDeps {
  store: ProjectRemovalStore & { projects: { saveProject(project: ProjectMetadata): Promise<void> } };
  workflows: AccountRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>;
  hub?: { shared(projectId: string): Promise<boolean>; takeBack(ownerId: string, projectId: string): Promise<void> } | undefined;
  now?: () => string;
}

export class ProjectRemovalService {
  constructor(private readonly deps: ProjectRemovalDeps) {}

  private async owned(ownerId: string, projectId: string): Promise<LoadedProjectScope | undefined> {
    const loaded = await loadProjectScope(this.deps.store, projectId);
    return loaded && loaded.project.ownerId === ownerId ? loaded : undefined;
  }

  async preview(ownerId: string, projectId: string): Promise<(ProjectRemovalPreview & { state: ProjectRemovalState }) | undefined> {
    const loaded = await this.owned(ownerId, projectId);
    if (!loaded) return undefined;
    const sharedOnHub = (await this.deps.hub?.shared(projectId)) ?? false;
    return { ...projectRemovalPreview(loaded.project, loaded.scope), ...(sharedOnHub ? { sharedOnHub } : {}), state: await this.deps.workflows.state(removeProjectWorkflowId(projectId)) };
  }

  async remove(ownerId: string, projectId: string, confirm: string): Promise<{ ok: true; state: ProjectRemovalState } | { ok: false; refusal: ProjectRemovalRefusal }> {
    const loaded = await this.owned(ownerId, projectId);
    if (!loaded) return { ok: false, refusal: { status: 404, error: 'Project not found' } };
    if (confirm.trim() !== loaded.project.name) return { ok: false, refusal: { status: 400, error: `Type the project's name, ${loaded.project.name}, to confirm` } };

    const workflowId = removeProjectWorkflowId(projectId);
    const current = await this.deps.workflows.state(workflowId);
    if (current.state === 'running') return { ok: true, state: current };
    if (this.deps.hub && await this.deps.hub.shared(projectId)) await this.deps.hub.takeBack(ownerId, projectId);
    await this.deps.store.projects.saveProject({ ...loaded.project, removal: { startedAt: this.deps.now?.() ?? new Date().toISOString(), requestedBy: ownerId } });
    await this.deps.workflows.start(REMOVE_PROJECT_WORKFLOW, workflowId, [{ projectId }], loaded.project.ownerId ?? ownerId);
    return { ok: true, state: await this.deps.workflows.state(workflowId) };
  }
}
