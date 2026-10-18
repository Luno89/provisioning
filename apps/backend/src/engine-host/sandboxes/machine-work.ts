import type { BroughtBack, WorkspaceDocuments } from './workspace-documents.js';
import type { WorkspaceRepoResolver } from './workspace-repos.js';

export interface MachineWorkRequest {
  ownerId: string;
  workspaceRunId: string;
  worktree?: string | undefined;
  branch: string;
}

export interface MachineWork {
  send(request: MachineWorkRequest & { message: string }): Promise<{ repo: string; folder: string; commit: string }>;
  take(request: MachineWorkRequest): Promise<BroughtBack>;
  drop(request: MachineWorkRequest): Promise<void>;
}

export function createMachineWork(options: { documents: WorkspaceDocuments; repoFor: WorkspaceRepoResolver }): MachineWork {
  const where = async (request: MachineWorkRequest): Promise<{ repo: string; folder: string }> => {
    const repo = await options.repoFor(request.workspaceRunId);
    if (!repo) throw new Error(`${request.workspaceRunId} keeps no repository, so its work cannot go to a machine`);
    return { repo: repo.repo, folder: request.worktree ? `/work/${request.worktree}` : repo.path };
  };

  return {
    async send(request) {
      const { repo, folder } = await where(request);
      const { commit } = await options.documents.sendBranch({ ...request, repo, folder, message: request.message });
      return { repo, folder, commit };
    },
    async take(request) {
      const { repo, folder } = await where(request);
      return options.documents.takeBranch({ ...request, repo, folder });
    },
    async drop(request) {
      const { repo } = await where(request);
      await options.documents.dropBranch({ ownerId: request.ownerId, repo, branch: request.branch });
    },
  };
}
