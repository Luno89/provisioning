import type { DeploymentMetadata, PipelineRunMetadata, ProjectMetadata } from './types.js';
import type { Tree } from './trees.js';
import { primaryProjectId } from './trees.js';
import { deletionScope, type DeletionScope, type GroveWorld } from './grove-deletion.js';
import { adoptionWorkflowId, concludeWorkspaceId, groveRunWorkflowId } from '../engine-host/temporal/contracts.js';
import { releaseWorkflowId } from './odoo-release.js';
import { releaseRunWorkflowId } from './release-run.js';

export const removeProjectWorkflowId = (projectId: string): string => `remove-project-${projectId}`;
export const REMOVE_PROJECT_WORKFLOW = 'RemoveProjectWorkflow';
export const PROJECT_REMOVAL_PROGRESS_QUERY = 'projectRemovalProgress';

export type ProjectRemovalStep = 'workflows' | 'apps' | 'workspaces' | 'secrets' | 'repositories' | 'records';

export interface ProjectWorld extends GroveWorld {
  trees: readonly Pick<Tree, 'id' | 'name' | 'ownerId' | 'projectIds'>[];
  deployments: readonly DeploymentMetadata[];
  pipelineRuns: readonly Pick<PipelineRunMetadata, 'id' | 'projectId' | 'status' | 'temporalWorkflowId'>[];
  conversations: readonly { id: string; ownerId?: string | undefined; treeId?: string | undefined; projectId?: string | undefined; kind?: 'channel' | 'item' | undefined }[];
}

export interface ProjectRemovalScope {
  projectId: string;
  repository?: string | undefined;
  trees: { id: string; name: string; scope: DeletionScope }[];
  unlinkedTreeIds: string[];
  keptConversationIds: string[];
  channelIds: string[];
  pipelineRunIds: string[];
  runningBuildWorkflowIds: string[];
  apps: { id: string; name: string }[];
}

export function projectApps(project: Pick<ProjectMetadata, 'id' | 'name'>, deployments: readonly DeploymentMetadata[]): DeploymentMetadata[] {
  return deployments.filter((deployment) => deployment.gitappProjectId === project.id
    || (!deployment.gitappProjectId && deployment.appType === 'gitapp' && deployment.name === project.name));
}

const RUNNING_BUILDS = ['queued', 'running'];

export function projectRemovalScope(project: Pick<ProjectMetadata, 'id' | 'name' | 'ownerId' | 'giteaOwner' | 'giteaRepo'>, world: ProjectWorld): ProjectRemovalScope {
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
    keptConversationIds: world.conversations.filter((conversation) => conversation.projectId === project.id && conversation.kind !== 'channel' && !goingWithTrees.has(conversation.id)).map((conversation) => conversation.id),
    channelIds: world.conversations.filter((conversation) => conversation.projectId === project.id && conversation.kind === 'channel' && !goingWithTrees.has(conversation.id)).map((conversation) => conversation.id),
    pipelineRunIds: runs.map((run) => run.id),
    runningBuildWorkflowIds: runs.filter((run) => RUNNING_BUILDS.includes(run.status) && run.temporalWorkflowId).map((run) => run.temporalWorkflowId!),
    apps: projectApps(project, world.deployments.filter((deployment) => deployment.ownerId === project.ownerId)).map((deployment) => ({ id: deployment.id, name: deployment.name })),
  };
}

export function projectWorkflowIds(scope: ProjectRemovalScope): string[] {
  return [...new Set([
    releaseWorkflowId(scope.projectId),
    releaseRunWorkflowId(scope.projectId),
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
  apps: string[];
}

export function projectRemovalPreview(project: Pick<ProjectMetadata, 'id' | 'name'>, scope: ProjectRemovalScope): ProjectRemovalPreview {
  return {
    name: project.name,
    ...(scope.repository ? { repository: scope.repository } : {}),
    trees: scope.trees.map((tree) => ({ id: tree.id, name: tree.name, leaves: tree.scope.leafIds.length, conversations: tree.scope.conversationIds.length })),
    keptConversations: scope.keptConversationIds.length,
    builds: scope.pipelineRunIds.length,
    apps: scope.apps.map((app) => app.name),
  };
}
