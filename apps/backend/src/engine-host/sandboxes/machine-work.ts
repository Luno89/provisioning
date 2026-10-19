import type { BroughtBack, WorkspaceDocuments } from './workspace-documents.js';
import type { WorkspaceRepoResolver } from './workspace-repos.js';
import type { EnvironmentRequest } from './environments.js';

export interface MachineWorkRequest {
  ownerId: string;
  workspaceRunId: string;
  worktree?: string | undefined;
  branch: string;
}

export type MachineSendRequest = MachineWorkRequest & { message: string; start?: EnvironmentRequest | undefined };

export interface MachineWork {
  send(request: MachineWorkRequest & { message: string }): Promise<{ repo: string; folder: string; commit: string }>;
  take(request: MachineWorkRequest & { message?: string | undefined }): Promise<BroughtBack>;
  keep(request: MachineWorkRequest): Promise<{ kept: true; commit: string } | { kept: false; why: string }>;
  drop(request: MachineWorkRequest): Promise<void>;
}

export function createMachineWork(options: { documents: WorkspaceDocuments; repoFor: WorkspaceRepoResolver }): MachineWork {
  const where = async (request: MachineWorkRequest): Promise<{ repo: string; folder: string; describe: string }> => {
    const repo = await options.repoFor(request.workspaceRunId);
    if (!repo) throw new Error(`${request.workspaceRunId} keeps no repository, so its work cannot go to a machine`);
    return { repo: repo.repo, folder: request.worktree ? `/work/${request.worktree}` : repo.path, describe: repo.describe };
  };

  return {
    async send(request) {
      const { repo, folder, describe } = await where(request);
      const { commit } = await options.documents.sendBranch({ ...request, repo, folder, describe, message: request.message });
      return { repo, folder, commit };
    },
    async take(request) {
      const { repo, folder } = await where(request);
      return options.documents.takeBranch({ ...request, repo, folder });
    },
    async keep(request) {
      const { repo, folder } = await where(request);
      return options.documents.keepBranch({ ...request, repo, folder });
    },
    async drop(request) {
      const { repo } = await where(request);
      await options.documents.dropBranch({ ownerId: request.ownerId, repo, branch: request.branch });
    },
  };
}
