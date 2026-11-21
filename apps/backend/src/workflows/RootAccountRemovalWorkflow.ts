import { condition, defineQuery, defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type { RootRemovalActivities } from '../activities/RootRemovalActivities.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { KOALA_REMOVAL_QUERY, KOALA_REMOVAL_SIGNAL, REMOVAL_PROGRESS_QUERY, type RemovalStep } from '../accounts/lib/account-removal.js';
import { laterThan, type DeletionProgress } from '../projects/lib/project-deletion.js';
import { koalaInstallWorkflowId } from '../instances/lib/koala-installs.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<RootRemovalActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const rootRemovalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);
export const koalaRemovalQuery = defineQuery<DeletionProgress | undefined>(KOALA_REMOVAL_QUERY);
const koalaRemovalSignal = defineSignal<[DeletionProgress]>(KOALA_REMOVAL_SIGNAL);

export async function RootAccountRemovalWorkflow(args: { ownerId: string }): Promise<{ meshDevices: number; records: Record<string, number> }> {
  const done: RemovalStep[] = [];
  let koala: DeletionProgress | undefined;
  setHandler(rootRemovalProgressQuery, () => [...done]);
  setHandler(koalaRemovalQuery, () => koala);
  setHandler(koalaRemovalSignal, (progress) => { if (laterThan(progress, koala)) koala = progress; });
  const found = await steps.RootRemovalInstanceActivity(args);
  if (found.installId) await getExternalWorkflowHandle(koalaInstallWorkflowId(found.installId)).cancel().catch(ignore('an install that has already ended has nothing left to stop'));
  done.push('instance');
  if (found.koala) await condition(() => koala?.phase === 'deleted');
  done.push('koala');
  const mesh = await steps.RootRemovalMeshActivity(args);
  done.push('mesh');
  const records = await steps.RootRemovalRecordsActivity(args);
  done.push('records');
  return { meshDevices: mesh.devices, records };
}
