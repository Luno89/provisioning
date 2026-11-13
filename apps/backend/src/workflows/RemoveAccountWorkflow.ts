import { defineQuery, executeChild, patched, proxyActivities, setHandler, sleep, startChild } from '@temporalio/workflow';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { DESTROYS_NAMED_ONCE_STARTED, FENCED_REMOVAL, REMOVAL_PROGRESS_QUERY, UNFENCED_STOP_GRACE_MS, type RemovalStep } from '../accounts/lib/account-removal.js';
import type { AccountRemovalActivities, RemoveAccountArgs } from '../activities/RemoveAccountActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';

const steps = proxyActivities<AccountRemovalActivities>({
  retry: ACTIVITY_RETRY,
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

  const fenced = patched(FENCED_REMOVAL);
  if (fenced) await steps.RemoveAccountFenceActivity(args);
  const stoppedWorkflows = await steps.RemoveAccountWorkflowsActivity(args);
  if (!fenced && stoppedWorkflows > 0) await sleep(UNFENCED_STOP_GRACE_MS);
  let repositories = false;
  if (fenced) {
    done.push('workflows');
    repositories = await steps.RemoveAccountRepositoriesActivity(args);
    done.push('repositories');
    if (args.keepRunsFor) await steps.RemoveAccountKeepRunsActivity({ ownerId: args.ownerId, keepRunsFor: args.keepRunsFor });
  } else {
    if (args.keepRunsFor) await steps.RemoveAccountKeepRunsActivity({ ownerId: args.ownerId, keepRunsFor: args.keepRunsFor });
    done.push('workflows');
  }
  const apps = await steps.RemoveAccountAppsActivity(args);
  for (const app of apps) {
    if (patched(DESTROYS_NAMED_ONCE_STARTED)) {
      const destroy = await startChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
      await steps.RemoveAccountAppStartedActivity({ deploymentId: app.deploymentId, workflowId: app.workflowId });
      await destroy.result();
    } else {
      await executeChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
    }
  }
  done.push('apps');
  await steps.RemoveAccountWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveAccountSecretsActivity(args);
  done.push('secrets');
  const mesh = await steps.RemoveAccountMeshActivity(args);
  done.push('mesh');
  if (!fenced) {
    repositories = await steps.RemoveAccountRepositoriesActivity(args);
    done.push('repositories');
  }
  const records = await steps.RemoveAccountRecordsActivity(args);
  done.push('records');

  return { stoppedWorkflows, apps: apps.length, secrets, meshDevices: mesh.devices, repositories, records };
}
