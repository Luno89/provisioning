import type { CommitPlan, StoredFileCommit } from './stored-files.js';

export const STORED_FILES_WORKFLOW = 'StoredFilesWorkflow';
export const STORED_FILES_SWEEP_WORKFLOW = 'StoredFilesSweepWorkflow';
export const STORED_FILES_SWEEP_ID = 'stored-files-sweep';
export const SWEEP_BATCH = 500;

export const storedFilesWorkflowId = (ownerId: string, id: string): string => `stored-files-${ownerId}-${id}`;

export type StoredFilesWork =
  | { op: 'commit'; ownerId: string; commits: StoredFileCommit[]; replace: boolean }
  | { op: 'remove'; ownerId: string; ids: string[] };

export type StoredFilesDone = { op: 'commit'; plan: CommitPlan } | { op: 'remove'; removed: number };

export interface StoredFilesSwept {
  deadUploads: number;
  expired: number;
  orphans: number;
}

export interface StoredFilesActivities {
  StoredFilesCommitActivity(args: { commits: StoredFileCommit[]; replace: boolean }): Promise<CommitPlan>;
  StoredFilesForgetActivity(args: { ids: string[] }): Promise<void>;
  StoredFilesRemoveBytesActivity(args: { ids: string[] }): Promise<void>;
  StoredFilesSweepActivity(): Promise<StoredFilesSwept>;
}

export async function doStoredFilesWork(work: StoredFilesWork, activities: Omit<StoredFilesActivities, 'StoredFilesSweepActivity'>): Promise<StoredFilesDone> {
  if (work.op === 'remove') {
    await activities.StoredFilesForgetActivity({ ids: work.ids });
    await activities.StoredFilesRemoveBytesActivity({ ids: work.ids });
    return { op: 'remove', removed: work.ids.length };
  }
  const plan = await activities.StoredFilesCommitActivity({ commits: work.commits, replace: work.replace });
  if (!plan.ok) {
    const refusedIds = work.commits.map((commit) => commit.id);
    await activities.StoredFilesForgetActivity({ ids: refusedIds });
    await activities.StoredFilesRemoveBytesActivity({ ids: refusedIds });
  } else if (plan.replaced.length > 0) {
    await activities.StoredFilesRemoveBytesActivity({ ids: plan.replaced });
  }
  return { op: 'commit', plan };
}
