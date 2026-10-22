import { defineQuery, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type { RootRemovalActivities } from '../activities/RootRemovalActivities.js';
import type * as pool from '../activities/PoolActivities.js';
import { DESTROY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { REMOVAL_PROGRESS_QUERY, type RemovalStep } from '../accounts/lib/account-removal.js';
import { poolTrialWorkflowId, TRIAL_CHANGED } from '../instances/lib/pool-trial.js';

const steps = proxyActivities<RootRemovalActivities & Pick<typeof pool, 'PoolRemoveActivity'>>({ retry: DESTROY_RETRY, ...LIVE_ACTIVITY });

export const rootRemovalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);

export async function RootAccountRemovalWorkflow(args: { ownerId: string }): Promise<{ poolInstance: boolean; meshDevices: number; records: Record<string, number> }> {
  const done: RemovalStep[] = [];
  setHandler(rootRemovalProgressQuery, () => [...done]);
  const { poolInstanceId } = await steps.RootRemovalInstanceActivity(args);
  if (poolInstanceId) {
    await steps.PoolRemoveActivity({ instanceId: poolInstanceId });
    await getExternalWorkflowHandle(poolTrialWorkflowId(poolInstanceId)).signal(TRIAL_CHANGED).catch(() => undefined);
  }
  done.push('instance');
  const mesh = await steps.RootRemovalMeshActivity(args);
  done.push('mesh');
  const records = await steps.RootRemovalRecordsActivity(args);
  done.push('records');
  return { poolInstance: Boolean(poolInstanceId), meshDevices: mesh.devices, records };
}
