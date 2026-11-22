import {
  partDeleted,
  partDeleting,
  workClosed,
  workerRestarted,
  type DeletionPart,
  type DeletionProgress,
  type OpenWork,
} from '../projects/lib/project-deletion.js';
import type { FrozenWorkActivities } from '../activities/DeleteProjectActivities.js';

export type Tell = (change: (current: DeletionProgress) => DeletionProgress) => Promise<void>;

export const innermostMessage = (err: unknown): string => {
  let inner = err as { message?: string; cause?: unknown } | undefined;
  while (inner?.cause) inner = inner.cause as { message?: string; cause?: unknown };
  return inner?.message ?? String(err);
};

export const deletingPart = (tell: Tell) => async <T>(name: DeletionPart, run: () => Promise<T>, count: (found: T) => number): Promise<T> => {
  await tell((current) => partDeleting(current, name));
  const found = await run();
  await tell((current) => partDeleted(current, name, count(found)));
  return found;
};

export async function awaitStopped(work: OpenWork, tell: Tell, cluster: FrozenWorkActivities): Promise<string[]> {
  const restarted: string[] = [];
  const { frozen, killed } = await cluster.AwaitProjectWorkActivity({ workflowId: work.workflowId });
  await tell((current) => workClosed(current, work.workflowId, frozen, killed));
  for (const worker of frozen) {
    const answer = await cluster.RestartWorkerActivity({ worker });
    if (answer === 'restarted') restarted.push(worker);
    await tell((current) => workerRestarted(current, worker, answer));
  }
  return restarted;
}
