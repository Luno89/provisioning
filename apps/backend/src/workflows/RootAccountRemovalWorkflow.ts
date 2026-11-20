import { defineQuery, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type { RootRemovalActivities } from '../activities/RootRemovalActivities.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { REMOVAL_PROGRESS_QUERY, type RemovalStep } from '../accounts/lib/account-removal.js';
import { koalaInstallWorkflowId } from '../instances/lib/koala-installs.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<RootRemovalActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const rootRemovalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);

export async function RootAccountRemovalWorkflow(args: { ownerId: string }): Promise<{ meshDevices: number; records: Record<string, number> }> {
  const done: RemovalStep[] = [];
  setHandler(rootRemovalProgressQuery, () => [...done]);
  const { installId } = await steps.RootRemovalInstanceActivity(args);
  if (installId) await getExternalWorkflowHandle(koalaInstallWorkflowId(installId)).cancel().catch(ignore('an install that has already ended has nothing left to stop'));
  done.push('instance');
  const mesh = await steps.RootRemovalMeshActivity(args);
  done.push('mesh');
  const records = await steps.RootRemovalRecordsActivity(args);
  done.push('records');
  return { meshDevices: mesh.devices, records };
}
