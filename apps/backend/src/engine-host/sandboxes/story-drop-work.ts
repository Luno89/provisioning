import { leafWorktree, TREE_REPO } from '../../projects/lib/plan-documents.js';
import type { WorkspaceDocuments } from './workspace-documents.js';
import { treeWorkspaceRunId, type WorkspaceRepoResolver } from './workspace-repos.js';

export type DropArrival =
  | { state: 'merged' }
  | { state: 'conflict'; conflicts: string[] }
  | { state: 'waiting'; staged: boolean };

export interface StoryDropWork {
  repoOf(treeId: string): Promise<string | undefined>;
  arrive(request: { ownerId: string; treeId: string; leafId: string; branch: string; message: string }): Promise<DropArrival>;
  forget(request: { ownerId: string; treeId: string; branch: string }): Promise<void>;
}

export function createStoryDropWork(options: { documents: WorkspaceDocuments; repoFor: WorkspaceRepoResolver }): StoryDropWork {
  const repoOf = async (treeId: string) => (await options.repoFor(treeWorkspaceRunId(treeId)))?.repo;

  return {
    repoOf,

    async arrive(request) {
      const repo = await repoOf(request.treeId);
      if (!repo) throw new Error(`tree ${request.treeId} keeps no repository`);
      const workspaceRunId = treeWorkspaceRunId(request.treeId);
      const folder = `/work/${leafWorktree(request.leafId)}`;
      if (await options.documents.holds({ workspaceRunId, path: `${folder}/.git` })) {
        const brought = await options.documents.applyDrop({ ownerId: request.ownerId, workspaceRunId, repo, folder, branch: request.branch, message: request.message });
        if (brought.brought) return { state: 'merged' };
        if (brought.conflicts?.length) return { state: 'conflict', conflicts: brought.conflicts };
        throw new Error(`the drop could not be merged into the story's checkout: ${brought.why}`);
      }
      if (await options.documents.holds({ workspaceRunId, path: `${TREE_REPO}/.git` })) {
        const kept = await options.documents.keepBranch({ ownerId: request.ownerId, workspaceRunId, repo, folder: TREE_REPO, branch: request.branch });
        if (!kept.kept) throw new Error(`the drop could not be brought into the tree's workspace: ${kept.why}`);
        return { state: 'waiting', staged: true };
      }
      return { state: 'waiting', staged: false };
    },

    async forget(request) {
      const repo = await repoOf(request.treeId);
      if (repo) await options.documents.dropBranch({ ownerId: request.ownerId, repo, branch: request.branch });
    },
  };
}
