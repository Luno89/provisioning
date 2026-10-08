import type { RunEnvironment } from '../temporal/contracts.js';
import type { EnvironmentResolver } from './environments.js';
import { destroyWorkspace, retirePod, workspaceRunning, type KubeRunner } from './kube.js';
import { POD, workspaceName } from './workspace.js';
import type { BroughtDocuments, MergeOutcome, SavedDocuments, WorkspaceDocuments } from './workspace-documents.js';
import { conversationRepoName, defaultRepoResolver, treeWorkspaceRunId, type WorkspaceRepoResolver } from './workspace-repos.js';
import { leafBranch, TREE_REPO } from '../../lib/plan-documents.js';

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
  save(treeId: string, ownerId: string): Promise<SavedDocuments>;
  park(treeId: string, ownerId: string): Promise<SavedDocuments>;
  release(treeId: string, ownerId: string): Promise<SavedDocuments>;
  bring(treeId: string, ownerId: string, conversationId: string): Promise<BroughtDocuments>;
  land(treeId: string, ownerId: string, leaves: readonly LandingLeaf[]): Promise<Landed[]>;
}

export const LANDING_BASE = 'main';

export interface LandingLeaf {
  leafId: string;
  title: string;
  body?: string | undefined;
  verdict?: string | undefined;
}

export interface Landed {
  leafId: string;
  outcome: MergeOutcome;
}

export function createTreeWorkspaces(options: { resolver: EnvironmentResolver; kube: KubeRunner; documents?: WorkspaceDocuments | undefined; repoFor?: WorkspaceRepoResolver | undefined; languageOf?: ((ownerId: string, treeId: string) => Promise<string | undefined>) | undefined }): TreeWorkspaces {
  const namespaceOf = (treeId: string): string => workspaceName(treeWorkspaceRunId(treeId));
  const repoOf = async (treeId: string) => (await (options.repoFor ?? defaultRepoResolver)(treeWorkspaceRunId(treeId)))!;
  const save = async (treeId: string, ownerId: string): Promise<SavedDocuments> => (options.documents
    ? options.documents.save({ ownerId, workspaceRunId: treeWorkspaceRunId(treeId), ...(await repoOf(treeId)) })
    : { saved: false, why: 'this server keeps no documents' });

  return {
    describe: async ({ treeId, ownerId, agents }) => {
      const language = await options.languageOf?.(ownerId, treeId);
      return options.resolver.describeShared({
        ticket: { runId: treeWorkspaceRunId(treeId), depth: 0, ownerId, agentSlug: 'grove-runner', trigger: 'user' },
        agents: [...new Set([...GROVE_WORKSPACE_AGENTS, ...(agents ?? [])])],
        ...(language ? { languages: [language] } : {}),
      });
    },

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
      ? options.documents.bring({ ownerId, workspaceRunId: treeWorkspaceRunId(treeId), ...(await repoOf(treeId)), from: conversationRepoName(conversationId) })
      : { brought: false, why: 'this server keeps no documents' }),

    async land(treeId, ownerId, leaves) {
      const documents = options.documents;
      if (!documents) throw new Error('this server keeps no documents, so nothing can land');
      if (leaves.length === 0) return [];
      const repo = await repoOf(treeId);
      const saved = await save(treeId, ownerId);
      if (!saved.saved && !saved.empty) throw new Error(`the tree's repository could not be saved before landing: ${saved.why}`);
      const landed: Landed[] = [];
      for (const leaf of leaves) {
        const outcome = await documents.merge({
          ownerId,
          repo: repo.repo,
          head: leafBranch(leaf.leafId),
          base: LANDING_BASE,
          title: `Land ${leaf.title}`,
          body: [leaf.body ? `Goal: ${leaf.body}` : '', leaf.verdict ? `Judged: ${leaf.verdict}` : ''].filter(Boolean).join('\n\n'),
        });
        landed.push({ leafId: leaf.leafId, outcome });
      }
      if (landed.some((entry) => entry.outcome === 'merged')) {
        await documents.catchUp({ ownerId, workspaceRunId: treeWorkspaceRunId(treeId), path: TREE_REPO, repo: repo.repo, branch: LANDING_BASE });
      }
      return landed;
    },
  };
}
