import { defineQuery, executeChild, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { DESTROY_RETRY } from '../lib/activity-retry.js';
import { ACTIVITY_STOP_GRACE_MS, REMOVAL_PROGRESS_QUERY, type RemovalStep } from '../lib/account-removal.js';
import type { AccountRemovalActivities, RemoveAccountArgs } from '../activities/RemoveAccountActivities.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';

const steps = proxyActivities<AccountRemovalActivities>({
  retry: DESTROY_RETRY,
  ...LIVE_ACTIVITY,
});

export const removalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);

export interface AccountRemoved {
  stoppedWorkflows: number;
  apps: number;
  secrets: number;
  meshDevices: number;
  repositories: boolean;
  records: Record<string, number>;
}

export async function RemoveAccountWorkflow(args: RemoveAccountArgs): Promise<AccountRemoved> {
  const done: RemovalStep[] = [];
  setHandler(removalProgressQuery, () => [...done]);

  const stoppedWorkflows = await steps.RemoveAccountWorkflowsActivity(args);
  if (stoppedWorkflows > 0) await sleep(ACTIVITY_STOP_GRACE_MS);
  if (args.keepRunsFor) await steps.RemoveAccountKeepRunsActivity({ ownerId: args.ownerId, keepRunsFor: args.keepRunsFor });
  done.push('workflows');
  const apps = await steps.RemoveAccountAppsActivity(args);
  for (const app of apps) await executeChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
  done.push('apps');
  await steps.RemoveAccountWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveAccountSecretsActivity(args);
  done.push('secrets');
  const mesh = await steps.RemoveAccountMeshActivity(args);
  done.push('mesh');
  const repositories = await steps.RemoveAccountRepositoriesActivity(args);
  done.push('repositories');
  const records = await steps.RemoveAccountRecordsActivity(args);
  done.push('records');

  return { stoppedWorkflows, apps: apps.length, secrets, meshDevices: mesh.devices, repositories, records };
}
