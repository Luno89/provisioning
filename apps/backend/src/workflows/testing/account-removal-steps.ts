import { temporalRemovalWorkflows } from '../../accounts/services/AccountRemovalService.js';
import type { AccountRemovalActivities } from '../../activities/RemoveAccountActivities.js';
import type { FrozenWorkActivities } from '../../activities/DeleteProjectActivities.js';
import { QUEUES } from '../../platform/lib/work-places.js';
import { testWorker, uniqueName } from './test-worker.js';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';

export const fakeRemovalSteps = (seen: string[], over: Partial<AccountRemovalActivities> = {}): AccountRemovalActivities => ({
  MarkAccountRemovingActivity: async () => { seen.push('mark'); },
  StopAccountWorkActivity: async () => { seen.push('workflows'); return []; },
  RemoveAccountProjectsActivity: async () => { seen.push('projects'); return []; },
  DeleteAccountProjectActivity: async ({ projectId }) => { seen.push(`project ${projectId}`); },
  RemoveAccountKeepRunsActivity: async ({ keepRunsFor }) => { seen.push(`keep for ${keepRunsFor}`); return 3; },
  RemoveAccountAppsActivity: async () => { seen.push('apps'); return []; },
  RemoveAccountAppStartedActivity: async () => undefined,
  RemoveAccountWorkspacesActivity: async () => { seen.push('workspaces'); return 'deleted'; },
  RemoveAccountSecretsActivity: async () => { seen.push('secrets'); return 0; },
  RemoveAccountMeshActivity: async () => { seen.push('mesh'); return { devices: 1, user: true }; },
  RemoveAccountRepositoriesActivity: async () => { seen.push('repositories'); return true; },
  RemoveAccountRecordsActivity: async () => { seen.push('records'); return { conversations: 3, users: 1 }; },
  ...over,
});

export const nothingFrozen = (seen: string[] = []): FrozenWorkActivities => ({
  AwaitProjectWorkActivity: async ({ workflowId }) => { seen.push(`await ${workflowId}`); return { frozen: [], killed: [] }; },
  RestartWorkerActivity: async ({ worker }) => { seen.push(`restart ${worker}`); return 'restarted'; },
});

export async function removingAccounts(env: TestTemporal, activities: AccountRemovalActivities, body: (workflows: ReturnType<typeof temporalRemovalWorkflows>) => Promise<void>, cluster: FrozenWorkActivities = nothingFrozen()): Promise<void> {
  const taskQueue = uniqueName('remove-account-test');
  const worker = await testWorker(env, { taskQueue, workflows: 'DeleteAccountWorkflow.ts', activities });
  const clusterWorker = await testWorker(env, { taskQueue: QUEUES.cluster, activities: cluster });
  await clusterWorker.runUntil(worker.runUntil(() => body(temporalRemovalWorkflows(() => env.client, taskQueue))));
}
