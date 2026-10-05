import type { RunEnvironment } from '../temporal/contracts.js';
import type { EnvironmentResolver } from './environments.js';
import { destroyWorkspace, retirePod, workspaceRunning, type KubeRunner } from './kube.js';
import { POD, workspaceName } from './workspace.js';
import type { BroughtDocuments, SavedDocuments, WorkspaceDocuments } from './workspace-documents.js';
import { conversationRepoName, repoForWorkspace, treeWorkspaceRunId } from './workspace-repos.js';

export { treeRepoName, treeWorkspaceRunId } from './workspace-repos.js';

export const GROVE_WORKSPACE_AGENTS = ['planner', 'executor', 'judge', 'leaf-judge'] as const;

export type TreeSandbox = Extract<RunEnvironment, { kind: 'sandbox' }>;

export type TreeWorkspaceState = 'none' | 'parked' | 'running';

export interface TreeWorkspaces {
  /**
   * The workspace every leaf of a tree works in. `agents` adds to the defaults: a tree type may name
   * its own agent for a stage, and that agent's binaries have to be in this image too, or the type
   * asks for a tool its own workspace does not have.
   */
  describe(request: { treeId: string; ownerId: string; agents?: readonly string[] | undefined }): Promise<TreeSandbox>;
  state(treeId: string): Promise<TreeWorkspaceState>;
  /** Saves the tree's repository to Gitea and leaves the pod as it is. */
  save(treeId: string, ownerId: string): Promise<SavedDocuments>;
  /** Saves the tree's repository to Gitea, then stops the pod. When the save fails the pod keeps running, so nothing unsaved is parked. */
  park(treeId: string, ownerId: string): Promise<SavedDocuments>;
  /** Saves the tree's repository to Gitea, then deletes the workspace. Throws, deleting nothing, when the save fails. */
  release(treeId: string, ownerId: string): Promise<SavedDocuments>;
  /** Stages the documents a conversation saved into the tree's repository at their own paths, leaving whatever the tree already has. The tree's workspace must be running. */
  bring(treeId: string, ownerId: string, conversationId: string): Promise<BroughtDocuments>;
}

export function createTreeWorkspaces(options: { resolver: EnvironmentResolver; kube: KubeRunner; documents?: WorkspaceDocuments | undefined }): TreeWorkspaces {
  const namespaceOf = (treeId: string): string => workspaceName(treeWorkspaceRunId(treeId));
  const save = async (treeId: string, ownerId: string): Promise<SavedDocuments> => (options.documents
    ? options.documents.save({ ownerId, workspaceRunId: treeWorkspaceRunId(treeId), ...repoForWorkspace(treeWorkspaceRunId(treeId))! })
    : { saved: false, why: 'this server keeps no documents' });

  return {
    describe: ({ treeId, ownerId, agents }) => options.resolver.describeShared({
      ticket: { runId: treeWorkspaceRunId(treeId), depth: 0, ownerId, agentSlug: 'grove-runner', trigger: 'user' },
      agents: [...new Set([...GROVE_WORKSPACE_AGENTS, ...(agents ?? [])])],
    }),

    async state(treeId) {
      const namespace = namespaceOf(treeId);
      const found = await options.kube(['get', 'namespace', namespace, '-o', 'name'], undefined, 15_000);
      if (found.exitCode !== 0) return 'none';
      return (await workspaceRunning(options.kube, namespace, POD).catch(() => false)) ? 'running' : 'parked';
    },

    save,

    async park(treeId, ownerId) {
      const saved = await save(treeId, ownerId).catch((err: Error): SavedDocuments => ({ saved: false, why: err.message, failed: true }));
      if (!saved.saved && saved.failed) return saved;
      await retirePod(options.kube, namespaceOf(treeId), POD);
      return saved;
    },

    async release(treeId, ownerId) {
      const saved = await save(treeId, ownerId);
      await destroyWorkspace(options.kube, namespaceOf(treeId));
      return saved;
    },

    bring: async (treeId, ownerId, conversationId) => (options.documents
      ? options.documents.bring({ ownerId, workspaceRunId: treeWorkspaceRunId(treeId), ...repoForWorkspace(treeWorkspaceRunId(treeId))!, from: conversationRepoName(conversationId) })
      : { brought: false, why: 'this server keeps no documents' }),
  };
}
