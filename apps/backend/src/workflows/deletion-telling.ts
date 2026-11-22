import { CancellationScope, proxyActivities } from '@temporalio/workflow';
import type { MachineWorkStop, MachineWorkStopped } from '@koala/engine-core';
import { deviceQueue } from '../engine-host/temporal/contracts.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import {
  machineRemoved,
  machineWorkStopped,
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

export interface MachineStopActivities {
  StopMachineWorkActivity(args: MachineWorkStop): Promise<MachineWorkStopped>;
}

export type MachineEnding = { ended: 'stopped'; killed: string[] } | { ended: 'removed' };

export type OnMachine = (deviceId: string, workflowIds: string[], cluster: FrozenWorkActivities) => Promise<MachineEnding>;

export const machineStops: OnMachine = (deviceId, workflowIds, cluster) => CancellationScope.cancellable(async () => {
  const machine = proxyActivities<MachineStopActivities>({ taskQueue: deviceQueue(deviceId), retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY, cancellationType: 'ABANDON' });
  const stopping = machine.StopMachineWorkActivity({ workflowIds }).then(({ killed }): MachineEnding => ({ ended: 'stopped', killed }));
  const removed = cluster.AwaitMachineRemovedActivity({ deviceId }).then((): MachineEnding => ({ ended: 'removed' }));
  try {
    return await Promise.race([stopping, removed]);
  } finally {
    CancellationScope.current().cancel();
    await Promise.allSettled([stopping, removed]);
  }
});

export async function awaitStopped(work: OpenWork, tell: Tell, cluster: FrozenWorkActivities, onMachine: OnMachine): Promise<string[]> {
  const restarted: string[] = [];
  const { frozen, killed, machines } = await cluster.AwaitProjectWorkActivity({ workflowId: work.workflowId });
  await tell((current) => workClosed(current, work.workflowId, frozen, killed, machines.map((machine) => machine.name)));
  for (const machine of machines) {
    const ending = await onMachine(machine.id, [work.workflowId], cluster);
    await tell((current) => (ending.ended === 'removed' ? machineRemoved(current, work.workflowId) : machineWorkStopped(current, work.workflowId, ending.killed)));
  }
  for (const worker of frozen) {
    const answer = await cluster.RestartWorkerActivity({ worker });
    if (answer === 'restarted') restarted.push(worker);
    await tell((current) => workerRestarted(current, worker, answer));
  }
  return restarted;
}
