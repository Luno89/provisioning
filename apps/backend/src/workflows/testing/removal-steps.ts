import type { Worker } from '@temporalio/worker';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';
import { DEFAULT_STREAM_TASK_QUEUE } from '../../engine-host/temporal/contracts.js';
import type { DeletionProgress } from '../../projects/lib/project-deletion.js';
import { testWorker } from './test-worker.js';

export const deletedForGood = (seen: string[]) => ({
  RemoveProjectRepositoriesActivity: async () => { seen.push('repositories'); return ['koala-bo/shop']; },
  RemoveProjectFilesActivity: async () => { seen.push('files'); return 2; },
  RemoveProjectRecordsActivity: async () => { seen.push('records'); return { projects: 1 }; },
});

export interface ToldDeletion {
  ownerId: string;
  projectId: string;
  progress: DeletionProgress;
}

export async function groveTold(env: TestTemporal): Promise<{ worker: Worker; told: string[]; deletions: ToldDeletion[] }> {
  const told: string[] = [];
  const deletions: ToldDeletion[] = [];
  const worker = await testWorker(env, {
    taskQueue: DEFAULT_STREAM_TASK_QUEUE,
    activities: {
      EngineGroveChangedActivity: async ({ ownerId }: { ownerId: string }) => { told.push(ownerId); },
      ProjectDeletionChangedActivity: async (change: ToldDeletion) => { deletions.push(change); },
    },
  });
  return { worker, told, deletions };
}

export const latest = (deletions: readonly ToldDeletion[]): DeletionProgress | undefined =>
  [...deletions].sort((a, b) => b.progress.seq - a.progress.seq)[0]?.progress;
