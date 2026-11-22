import { ApplicationFailure } from '@temporalio/common';
import { condition, defineQuery, defineSignal, getExternalWorkflowHandle, proxyActivities, setHandler } from '@temporalio/workflow';
import type { RootRemovalActivities } from '../activities/RootRemovalActivities.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import {
  KOALA_REMOVAL_QUERY,
  KOALA_REMOVAL_SIGNAL,
  MACHINE_REMOVALS_QUERY,
  MACHINE_UNINSTALLED_SIGNAL,
  REMOVAL_PROGRESS_QUERY,
  type MachineRemoval,
  type MachineUninstalled,
  type RemovalStep,
} from '../accounts/lib/account-removal.js';
import { laterThan, type DeletionProgress } from '../projects/lib/project-deletion.js';
import { koalaInstallWorkflowId } from '../instances/lib/koala-installs.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<RootRemovalActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const rootRemovalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);
export const koalaRemovalQuery = defineQuery<DeletionProgress | undefined>(KOALA_REMOVAL_QUERY);
export const machineRemovalsQuery = defineQuery<MachineRemoval[]>(MACHINE_REMOVALS_QUERY);
const koalaRemovalSignal = defineSignal<[DeletionProgress]>(KOALA_REMOVAL_SIGNAL);
const machineUninstalledSignal = defineSignal<[MachineUninstalled]>(MACHINE_UNINSTALLED_SIGNAL);

export async function RootAccountRemovalWorkflow(args: { ownerId: string }): Promise<{ meshDevices: number; records: Record<string, number> }> {
  const done: RemovalStep[] = [];
  let koala: DeletionProgress | undefined;
  let machines: { id: string; name: string }[] = [];
  const uninstalled = new Map<string, MachineUninstalled>();
  setHandler(rootRemovalProgressQuery, () => [...done]);
  setHandler(koalaRemovalQuery, () => koala);
  setHandler(machineRemovalsQuery, () => machines.map((machine) => ({ ...machine, state: uninstalled.has(machine.id) ? 'uninstalled' : 'uninstalling' })));
  setHandler(koalaRemovalSignal, (progress) => { if (laterThan(progress, koala)) koala = progress; });
  setHandler(machineUninstalledSignal, (word) => { uninstalled.set(word.id, word); });
  const found = await steps.RootRemovalInstanceActivity(args);
  if (found.installId) await getExternalWorkflowHandle(koalaInstallWorkflowId(found.installId)).cancel().catch(ignore('an install that has already ended has nothing left to stop'));
  done.push('instance');
  if (found.koala) await condition(() => koala?.phase === 'deleted');
  done.push('koala');
  machines = await steps.RootRemovalMachinesActivity(args);
  await condition(() => machines.every((machine) => uninstalled.has(machine.id)));
  const problems = machines.flatMap((machine) => {
    const problem = uninstalled.get(machine.id)?.problem;
    return problem ? [`${machine.name}: ${problem}`] : [];
  });
  if (problems.length) throw ApplicationFailure.nonRetryable(problems.join('; '), 'MachineNotUninstalled');
  done.push('machines');
  const mesh = await steps.RootRemovalMeshActivity(args);
  done.push('mesh');
  const records = await steps.RootRemovalRecordsActivity(args);
  done.push('records');
  return { meshDevices: mesh.devices, records };
}
