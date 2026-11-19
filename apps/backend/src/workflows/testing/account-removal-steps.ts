import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalRemovalWorkflows } from '../../accounts/services/AccountRemovalService.js';
import type { AccountRemovalActivities } from '../../activities/RemoveAccountActivities.js';
import { testWorker, uniqueName } from './test-worker.js';

export const fakeRemovalSteps = (seen: string[], over: Partial<AccountRemovalActivities> = {}): AccountRemovalActivities => ({
  RemoveAccountFenceActivity: async () => { seen.push('fence'); return []; },
  RemoveAccountFenceEndActivity: async () => { seen.push('fence ended'); return []; },
  RemoveAccountWorkflowsActivity: async () => { seen.push('workflows'); return 0; },
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

export async function removingAccounts(env: TestWorkflowEnvironment, activities: AccountRemovalActivities, body: (workflows: ReturnType<typeof temporalRemovalWorkflows>) => Promise<void>): Promise<void> {
  const taskQueue = uniqueName('remove-account-test');
  const worker = await testWorker(env, { taskQueue, workflows: 'RemoveAccountWorkflow.ts', activities });
  await worker.runUntil(() => body(temporalRemovalWorkflows(() => env.client, taskQueue)));
}
