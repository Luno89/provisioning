import type { DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from './types.js';
import type { Tree } from './trees.js';
import { primaryProjectId } from './trees.js';
import { deletionScope, type DeletionScope, type GroveWorld } from './grove-deletion.js';
import { deploymentForProject } from './project-status.js';
import { adoptionWorkflowId, concludeWorkspaceId, groveRunWorkflowId } from '../engine-host/temporal/contracts.js';
import { releaseWorkflowId } from './odoo-release.js';

export const removeProjectWorkflowId = (projectId: string): string => `remove-project-${projectId}`;
export const REMOVE_PROJECT_WORKFLOW = 'RemoveProjectWorkflow';
export const PROJECT_REMOVAL_PROGRESS_QUERY = 'projectRemovalProgress';

export type ProjectRemovalStep = 'workflows' | 'workspaces' | 'secrets' | 'repositories' | 'records';

export interface ProjectWorld extends GroveWorld {
  trees: readonly Pick<Tree, 'id' | 'name' | 'ownerId' | 'projectIds'>[];
  deployments: readonly DeploymentMetadata[];
  pipelineRuns: readonly Pick<PipelineRunMetadata, 'id' | 'projectId' | 'status' | 'temporalWorkflowId'>[];
  conversations: readonly { id: string; ownerId?: string | undefined; treeId?: string | undefined; projectId?: string | undefined }[];
}

export interface ProjectRemovalScope {
  projectId: string;
  repository?: string | undefined;
  trees: { id: string; name: string; scope: DeletionScope }[];
  unlinkedTreeIds: string[];
  keptConversationIds: string[];
  pipelineRunIds: string[];
  runningBuildWorkflowIds: string[];
}

const RUNNING_BUILDS = ['queued', 'running'];

export function projectRemovalScope(project: Pick<ProjectMetadata, 'id' | 'ownerId' | 'giteaOwner' | 'giteaRepo'>, world: ProjectWorld): ProjectRemovalScope {
  const owned = world.trees.filter((tree) => tree.ownerId === project.ownerId && (tree.projectIds ?? []).includes(project.id));
  const trees = owned.filter((tree) => primaryProjectId(tree) === project.id)
    .map((tree) => ({ id: tree.id, name: tree.name, scope: deletionScope({ kind: 'tree', id: tree.id }, world) }));
  const goingWithTrees = new Set(trees.flatMap((tree) => tree.scope.conversationIds));
  const runs = world.pipelineRuns.filter((run) => run.projectId === project.id);
  return {
    projectId: project.id,
    ...(project.giteaOwner && project.giteaRepo ? { repository: `${project.giteaOwner}/${project.giteaRepo}` } : {}),
    trees,
    unlinkedTreeIds: owned.filter((tree) => primaryProjectId(tree) !== project.id).map((tree) => tree.id),
    keptConversationIds: world.conversations.filter((conversation) => conversation.projectId === project.id && !goingWithTrees.has(conversation.id)).map((conversation) => conversation.id),
    pipelineRunIds: runs.map((run) => run.id),
    runningBuildWorkflowIds: runs.filter((run) => RUNNING_BUILDS.includes(run.status) && run.temporalWorkflowId).map((run) => run.temporalWorkflowId!),
  };
}

export function projectRemovalBlockers(project: Pick<ProjectMetadata, 'id' | 'name'>, world: Pick<ProjectWorld, 'deployments'>): string[] {
  const deployed = deploymentForProject(project, [...world.deployments]);
  return deployed ? [`the app "${deployed.name}" built from it is still deployed; remove it first`] : [];
}

export function projectWorkflowIds(scope: ProjectRemovalScope): string[] {
  return [...new Set([
    releaseWorkflowId(scope.projectId),
    ...scope.runningBuildWorkflowIds,
    ...scope.trees.flatMap((tree) => [
      groveRunWorkflowId(tree.id),
      concludeWorkspaceId({ kind: 'tree', id: tree.id }),
      ...tree.scope.adoptingProposalIds.map(adoptionWorkflowId),
    ]),
  ])];
}

export interface ProjectRemovalPreview {
  name: string;
  repository?: string | undefined;
  trees: { id: string; name: string; leaves: number; conversations: number }[];
  keptConversations: number;
  builds: number;
  blockers: string[];
}

export function projectRemovalPreview(project: Pick<ProjectMetadata, 'id' | 'name'>, scope: ProjectRemovalScope, blockers: string[]): ProjectRemovalPreview {
  return {
    name: project.name,
    ...(scope.repository ? { repository: scope.repository } : {}),
    trees: scope.trees.map((tree) => ({ id: tree.id, name: tree.name, leaves: tree.scope.leafIds.length, conversations: tree.scope.conversationIds.length })),
    keptConversations: scope.keptConversationIds.length,
    builds: scope.pipelineRunIds.length,
    blockers,
  };
}
