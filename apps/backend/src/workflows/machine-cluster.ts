import { ApplicationFailure, proxyActivities } from '@temporalio/workflow';
import type { MachineClusterOp, MachineClusterResult } from '@koala/engine-core';
import { DEFAULT_STREAM_TASK_QUEUE, deviceQueue } from '../engine-host/temporal/contracts.js';
import type { StreamActivities } from '../engine-host/temporal/activities.js';
import type { MachineOfCluster } from '../infrastructure/index.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

type Records = Pick<StreamActivities, 'EngineMachineClusterStartedActivity' | 'EngineMachineClusterStoppedActivity' | 'EngineMachineClusterIdleActivity'>;

const records = proxyActivities<Records>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const onMachine = (deviceId: string) => proxyActivities<{ MachineClusterActivity(op: MachineClusterOp): Promise<MachineClusterResult> }>({
  taskQueue: deviceQueue(deviceId),
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

export async function startMachineCluster(machine: MachineOfCluster, clusterId: string): Promise<string> {
  const result = await onMachine(machine.deviceId).MachineClusterActivity({ kind: 'start' });
  if (result.state !== 'running') throw ApplicationFailure.nonRetryable(`the machine answered ${result.state} when its cluster was started`, 'MachineClusterNotRunning');
  await records.EngineMachineClusterStartedActivity({ clusterId, result });
  return result.kubeconfig;
}

export async function stopMachineClusterWhenIdle(machine: MachineOfCluster, clusterId: string): Promise<boolean> {
  if (!await records.EngineMachineClusterIdleActivity({ clusterId, leaving: machine.leaving })) return false;
  await onMachine(machine.deviceId).MachineClusterActivity({ kind: 'stop' });
  await records.EngineMachineClusterStoppedActivity({ clusterId });
  return true;
}
