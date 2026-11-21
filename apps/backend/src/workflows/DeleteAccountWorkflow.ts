import { defineQuery, proxyActivities, setHandler, startChild } from '@temporalio/workflow';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { REMOVAL_PROGRESS_QUERY, type RemovalStep } from '../accounts/lib/account-removal.js';
import type { AccountRemovalActivities, RemoveAccountArgs } from '../activities/RemoveAccountActivities.js';
import type { FrozenWorkActivities } from '../activities/DeleteProjectActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { QUEUES } from '../platform/lib/work-places.js';

const steps = proxyActivities<AccountRemovalActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const cluster = proxyActivities<FrozenWorkActivities>({ taskQueue: QUEUES.cluster, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

export const removalProgressQuery = defineQuery<RemovalStep[]>(REMOVAL_PROGRESS_QUERY);

export interface AccountRemoved {
  stopped: string[];
  projects: string[];
  apps: number;
  secrets: number;
  meshDevices: number;
  repositories: boolean;
  records: Record<string, number>;
}

export async function DeleteAccountWorkflow(args: RemoveAccountArgs): Promise<AccountRemoved> {
  const done: RemovalStep[] = [];
  setHandler(removalProgressQuery, () => [...done]);

  const stopped: string[] = [];
  const stop = async (): Promise<number> => {
    const open = await steps.StopAccountWorkActivity(args);
    stopped.push(...open.map((work) => work.workflowId));
    await Promise.all(open.map(async (work) => {
      const { frozen } = await cluster.AwaitProjectWorkActivity({ workflowId: work.workflowId });
      for (const worker of frozen) await cluster.RestartWorkerActivity({ worker });
    }));
    return open.length;
  };

  let apps = 0;
  const destroyApps = async (): Promise<void> => {
    for (const app of await steps.RemoveAccountAppsActivity(args)) {
      const destroy = await startChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
      await steps.RemoveAccountAppStartedActivity({ deploymentId: app.deploymentId, workflowId: app.workflowId });
      await destroy.result();
      apps += 1;
    }
  };

  await steps.MarkAccountRemovingActivity(args);
  await stop();
  done.push('workflows');
  const projects = await steps.RemoveAccountProjectsActivity(args);
  for (const projectId of projects) await steps.DeleteAccountProjectActivity({ ownerId: args.ownerId, projectId });
  done.push('projects');
  const repositories = await steps.RemoveAccountRepositoriesActivity(args);
  done.push('repositories');
  if (args.keepRunsFor) await steps.RemoveAccountKeepRunsActivity({ ownerId: args.ownerId, keepRunsFor: args.keepRunsFor });
  await destroyApps();
  done.push('apps');
  await steps.RemoveAccountWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveAccountSecretsActivity(args);
  done.push('secrets');
  while ((await stop()) > 0) {
    await destroyApps();
    await steps.RemoveAccountWorkspacesActivity(args);
  }
  const mesh = await steps.RemoveAccountMeshActivity(args);
  done.push('mesh');
  const records = await steps.RemoveAccountRecordsActivity(args);
  done.push('records');

  return { stopped, projects, apps, secrets, meshDevices: mesh.devices, repositories, records };
}
