import { Context } from '@temporalio/activity';
import type { ProjectMetadata, DeploymentMetadata, PipelineRunMetadata } from '../lib/types.js';
import type { Tree } from '../lib/trees.js';
import type { Branch, Leaf } from '../lib/leaves.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { PlanProposal } from '../lib/plan-proposals.js';
import type { Conversation } from '../lib/conversations.js';
import { projectWorkflowIds } from '../lib/project-removal.js';
import { loadProjectScope } from '../services/ProjectRemovalService.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { workspaceName } from '../engine-host/sandboxes/workspace.js';
import { conversationRepoName, conversationWorkspaceRunId, treeRepoName, treeWorkspaceRunId } from '../engine-host/sandboxes/workspace-repos.js';

export interface RemoveProjectArgs {
  projectId: string;
}

export interface ProjectRemovalStore {
  getProjects(): Promise<ProjectMetadata[]>;
  getTrees(): Promise<Tree[]>;
  saveTree(tree: Tree): Promise<void>;
  getBranches(): Promise<Branch[]>;
  getLeaves(): Promise<Leaf[]>;
  getTasks(ownerId?: string): Promise<Task[]>;
  getPlanProposals(ownerId: string): Promise<PlanProposal[]>;
  getConversations(): Promise<Conversation[]>;
  getDeployments(): Promise<DeploymentMetadata[]>;
  getPipelineRuns(): Promise<PipelineRunMetadata[]>;
  getGiteaAccount(ownerId: string): Promise<{ username: string } | null>;
  deleteTree(id: string): Promise<void>;
  deleteBranch(id: string): Promise<void>;
  deleteLeaf(id: string): Promise<void>;
  deleteTask(id: string): Promise<void>;
  deletePlanProposal(ownerId: string, id: string): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  removeProjectRecords(projectId: string): Promise<Record<string, number>>;
}

export interface ProjectRemovalDeps {
  store: ProjectRemovalStore;
  workflows: { stopIfRunning(workflowId: string, reason: string): Promise<boolean> };
  kube: KubeRunner;
  repositories: { deleteRepo(owner: string, name: string): Promise<void> };
  secrets: { removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> };
}

export interface ProjectRemovalActivities {
  RemoveProjectWorkflowsActivity(args: RemoveProjectArgs): Promise<number>;
  RemoveProjectWorkspacesActivity(args: RemoveProjectArgs): Promise<number>;
  RemoveProjectSecretsActivity(args: RemoveProjectArgs): Promise<{ workspace: boolean; readers: number }>;
  RemoveProjectRepositoriesActivity(args: RemoveProjectArgs): Promise<string[]>;
  RemoveProjectRecordsActivity(args: RemoveProjectArgs): Promise<Record<string, number>>;
}

const REASON = 'the project was deleted';

const heartbeat = () => {
  try {
    Context.current().heartbeat();
  } catch {
    return;
  }
};

export function createProjectRemovalActivities(deps: ProjectRemovalDeps): ProjectRemovalActivities {
  const { store } = deps;

  const scopeOf = (projectId: string) => loadProjectScope(store, projectId);

  return {
    async RemoveProjectWorkflowsActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return 0;
      let stopped = 0;
      for (const id of projectWorkflowIds(found.scope)) {
        if (await deps.workflows.stopIfRunning(id, REASON)) stopped += 1;
        heartbeat();
      }
      return stopped;
    },

    async RemoveProjectWorkspacesActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return 0;
      const runIds = [
        ...found.scope.trees.map((tree) => treeWorkspaceRunId(tree.id)),
        ...found.scope.trees.flatMap((tree) => tree.scope.conversationIds.map(conversationWorkspaceRunId)),
      ];
      if (runIds.length === 0) return 0;
      const result = await deps.kube(['delete', 'namespace', ...runIds.map(workspaceName), '--ignore-not-found', '--wait=true', '--timeout=300s'], undefined, 330_000);
      if (result.exitCode !== 0) throw new Error(`the project's workspaces could not be deleted: ${result.stderr.trim() || result.stdout.trim()}`);
      return runIds.length;
    },

    async RemoveProjectSecretsActivity({ projectId }) {
      return deps.secrets.removeProject(projectId);
    },

    async RemoveProjectRepositoriesActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return [];
      const account = await store.getGiteaAccount(found.project.ownerId ?? '');
      const repos: { owner: string; name: string }[] = [
        ...(found.project.giteaOwner && found.project.giteaRepo ? [{ owner: found.project.giteaOwner, name: found.project.giteaRepo }] : []),
        ...(account ? [
          ...found.scope.trees.map((tree) => ({ owner: account.username, name: treeRepoName(tree.id) })),
          ...found.scope.trees.flatMap((tree) => tree.scope.conversationIds.map((id) => ({ owner: account.username, name: conversationRepoName(id) }))),
        ] : []),
      ];
      for (const repo of repos) {
        await deps.repositories.deleteRepo(repo.owner, repo.name);
        heartbeat();
      }
      return repos.map((repo) => `${repo.owner}/${repo.name}`);
    },

    async RemoveProjectRecordsActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return {};
      const ownerId = found.project.ownerId ?? '';
      const removed: Record<string, number> = {};
      const count = (name: string, n: number) => { if (n) removed[name] = (removed[name] ?? 0) + n; };
      for (const { scope } of found.scope.trees) {
        for (const id of scope.taskIds) await store.deleteTask(id);
        for (const id of scope.leafIds) await store.deleteLeaf(id);
        for (const id of scope.proposalIds) await store.deletePlanProposal(ownerId, id);
        for (const id of scope.conversationIds) await store.deleteConversation(id);
        for (const id of scope.branchIds) await store.deleteBranch(id);
        if (scope.treeId) await store.deleteTree(scope.treeId);
        count('tasks', scope.taskIds.length);
        count('leaves', scope.leafIds.length);
        count('planProposals', scope.proposalIds.length);
        count('conversations', scope.conversationIds.length);
        count('branches', scope.branchIds.length);
        count('trees', scope.treeId ? 1 : 0);
        heartbeat();
      }
      const trees = await store.getTrees();
      for (const id of found.scope.unlinkedTreeIds) {
        const tree = trees.find((entry) => entry.id === id);
        if (tree) await store.saveTree({ ...tree, projectIds: (tree.projectIds ?? []).filter((linked) => linked !== projectId) });
      }
      count('trees unlinked', found.scope.unlinkedTreeIds.length);
      for (const [name, n] of Object.entries(await store.removeProjectRecords(projectId))) count(name, n);
      return removed;
    },
  };
}
