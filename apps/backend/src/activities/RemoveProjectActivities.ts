import { Context } from '@temporalio/activity';
import type { FilePlace } from '../files/lib/file-places.js';
import {
  type ClusterMetadata, type ProjectMetadata, type DeploymentMetadata, type PipelineRunMetadata, CLI_CEILING,
} from '../platform/index.js';
import { destroyAppArgs, destroyAppWorkflowId, type DestroyAppArgs } from '../infrastructure/index.js';
import type { Tree } from '../projects/lib/trees.js';
import type { Branch, Leaf } from '../projects/lib/leaves.js';
import type { Task } from '../engine-host/tools/tasks.js';
import type { PlanProposal } from '../projects/lib/plan-proposals.js';
import type { Conversation } from '../engine/lib/conversations.js';
import { projectWorkflowIds } from '../projects/lib/project-removal.js';
import { loadProjectScope } from '../projects/services/ProjectRemovalService.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { workspaceName } from '../engine-host/sandboxes/workspace.js';
import { conversationRepoName, conversationWorkspaceRunId, treeRepoName, treeWorkspaceRunId } from '../engine-host/sandboxes/workspace-repos.js';

export interface RemoveProjectArgs {
  projectId: string;
}

export interface ProjectRemovalStore {
  projects: {
    getProjects(): Promise<ProjectMetadata[]>;
    getTrees(): Promise<Tree[]>;
    saveTree(tree: Tree): Promise<void>;
    getBranches(): Promise<Branch[]>;
    getLeaves(): Promise<Leaf[]>;
    getTasks(ownerId?: string): Promise<Task[]>;
    getPlanProposals(ownerId: string): Promise<PlanProposal[]>;
    getGiteaAccount(ownerId: string): Promise<{ username: string } | null>;
    deleteTree(id: string): Promise<void>;
    deleteBranch(id: string): Promise<void>;
    deleteLeaf(id: string): Promise<void>;
    deleteTask(id: string): Promise<void>;
    deletePlanProposal(ownerId: string, id: string): Promise<void>;
    removeProjectRecords(projectId: string): Promise<Record<string, number>>;
  };
  engine: {
    getConversations(): Promise<Conversation[]>;
    deletePublishedWorkspace(ownerId: string, treeId: string): Promise<void>;
    deleteConversation(id: string): Promise<void>;
  };
  infrastructure: {
    getDeployments(): Promise<DeploymentMetadata[]>;
    saveDeploymentInfo(deployment: Partial<DeploymentMetadata> & { id: string }): Promise<DeploymentMetadata>;
    deleteDeployment(id: string): Promise<void>;
  };
  releases: {
    getPipelineRuns(): Promise<PipelineRunMetadata[]>;
    getOdooReleases(ownerId: string, projectId?: string): Promise<{ id: string }[]>;
  };
}

export interface AppTeardown {
  clusterById(id: string): Promise<ClusterMetadata | undefined>;
  logFile(): string;
  taskQueue: string;
}

export interface AppToDestroy {
  deploymentId: string;
  workflowId: string;
  taskQueue: string;
  args: DestroyAppArgs;
}

export function planAppDestroys(deployments: readonly DeploymentMetadata[], ids: readonly string[], teardown: AppTeardown, nonce: () => string): Promise<AppToDestroy[]> {
  return Promise.all(deployments.filter((deployment) => ids.includes(deployment.id)).map(async (deployment) => ({
    deploymentId: deployment.id,
    workflowId: destroyAppWorkflowId(deployment, Date.now(), nonce()),
    taskQueue: teardown.taskQueue,
    args: destroyAppArgs(deployment, await teardown.clusterById(deployment.clusterId), teardown.logFile()),
  })));
}

export interface ProjectRemovalDeps {
  store: ProjectRemovalStore;
  apps: AppTeardown;
  workflows: { stopIfRunning(workflowId: string, reason: string): Promise<boolean> };
  kube: KubeRunner;
  repositories: { deleteRepo(owner: string, name: string): Promise<void> };
  secrets: { removeProject(projectId: string): Promise<{ workspace: boolean; readers: number }> };
  artifacts?: { removeRun(ownerId: string, runId: string): Promise<number> } | undefined;
  files?: { removeAll(ownerId: string, place: FilePlace): Promise<'removed' | 'unreachable'> } | undefined;
}

export interface ProjectRemovalActivities {
  RemoveProjectWorkflowsActivity(args: RemoveProjectArgs): Promise<number>;
  RemoveProjectAppsActivity(args: RemoveProjectArgs): Promise<AppToDestroy[]>;
  RemoveProjectWorkspacesActivity(args: RemoveProjectArgs): Promise<number>;
  RemoveProjectSecretsActivity(args: RemoveProjectArgs): Promise<{ workspace: boolean; readers: number }>;
  RemoveProjectRepositoriesActivity(args: RemoveProjectArgs): Promise<string[]>;
  RemoveProjectFilesActivity(args: RemoveProjectArgs): Promise<'removed' | 'unreachable' | 'none'>;
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

    async RemoveProjectAppsActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found || found.scope.apps.length === 0) return [];
      const planned = await planAppDestroys(await store.infrastructure.getDeployments(), found.scope.apps.map((app) => app.id), deps.apps, () => Math.random().toString(36).slice(2, 8));
      for (const app of planned) await store.infrastructure.saveDeploymentInfo({ id: app.deploymentId, status: 'destroying', temporalWorkflowId: app.workflowId, lastLogPath: app.args.logFile });
      return planned;
    },

    async RemoveProjectWorkspacesActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return 0;
      const runIds = [
        ...found.scope.trees.map((tree) => treeWorkspaceRunId(tree.id)),
        ...found.scope.trees.flatMap((tree) => tree.scope.conversationIds.map(conversationWorkspaceRunId)),
      ];
      if (runIds.length === 0) return 0;
      const result = await deps.kube(['delete', 'namespace', ...runIds.map(workspaceName), '--ignore-not-found', '--wait=true', `--timeout=${CLI_CEILING}`]);
      if (result.exitCode !== 0) throw new Error(`the project's workspaces could not be deleted: ${result.stderr.trim() || result.stdout.trim()}`);
      return runIds.length;
    },

    async RemoveProjectSecretsActivity({ projectId }) {
      return deps.secrets.removeProject(projectId);
    },

    async RemoveProjectRepositoriesActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return [];
      const account = await store.projects.getGiteaAccount(found.project.ownerId ?? '');
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

    async RemoveProjectFilesActivity({ projectId }) {
      const found = await scopeOf(projectId);
      const place = found?.project.files;
      if (!found || !place || !deps.files) return 'none';
      return deps.files.removeAll(found.project.ownerId ?? '', place);
    },

    async RemoveProjectRecordsActivity({ projectId }) {
      const found = await scopeOf(projectId);
      if (!found) return {};
      const ownerId = found.project.ownerId ?? '';
      const removed: Record<string, number> = {};
      const count = (name: string, n: number) => { if (n) removed[name] = (removed[name] ?? 0) + n; };
      for (const { scope } of found.scope.trees) {
        for (const id of scope.taskIds) await store.projects.deleteTask(id);
        for (const id of scope.leafIds) await store.projects.deleteLeaf(id);
        for (const id of scope.proposalIds) await store.projects.deletePlanProposal(ownerId, id);
        for (const id of scope.conversationIds) await store.engine.deleteConversation(id);
        for (const id of scope.branchIds) await store.projects.deleteBranch(id);
        if (scope.treeId) await store.projects.deleteTree(scope.treeId);
        if (scope.treeId) await store.engine.deletePublishedWorkspace(ownerId, scope.treeId);
        count('tasks', scope.taskIds.length);
        count('leaves', scope.leafIds.length);
        count('planProposals', scope.proposalIds.length);
        count('conversations', scope.conversationIds.length);
        count('branches', scope.branchIds.length);
        count('trees', scope.treeId ? 1 : 0);
        heartbeat();
      }
      const trees = await store.projects.getTrees();
      for (const id of found.scope.unlinkedTreeIds) {
        const tree = trees.find((entry) => entry.id === id);
        if (tree) await store.projects.saveTree({ ...tree, projectIds: (tree.projectIds ?? []).filter((linked) => linked !== projectId) });
      }
      count('trees unlinked', found.scope.unlinkedTreeIds.length);
      for (const id of found.scope.channelIds) await store.engine.deleteConversation(id);
      count('conversations', found.scope.channelIds.length);
      for (const app of found.scope.apps) await store.infrastructure.deleteDeployment(app.id);
      count('deployments', found.scope.apps.length);
      if (deps.artifacts && ownerId) {
        for (const release of await store.releases.getOdooReleases(ownerId, projectId)) count('artifacts', await deps.artifacts.removeRun(ownerId, release.id));
      }
      for (const [name, n] of Object.entries(await store.projects.removeProjectRecords(projectId))) count(name, n);
      return removed;
    },
  };
}
