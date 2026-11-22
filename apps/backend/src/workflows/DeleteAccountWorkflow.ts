import { defineQuery, proxyActivities, setHandler, startChild } from '@temporalio/workflow';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { REMOVAL_PROGRESS_QUERY, type AccountDeletionChange, type RemovalStep } from '../accounts/lib/account-removal.js';
import type { AccountRemovalActivities, RemoveAccountArgs } from '../activities/RemoveAccountActivities.js';
import type { FrozenWorkActivities } from '../activities/DeleteProjectActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { appRemoved, deletionBegun, deletionEnded, deletionStuck, partDeleted, partDeleting, workStopping } from '../projects/lib/project-deletion.js';
import { awaitStopped, deletingPart, innermostMessage, machineStops, type Tell } from './deletion-telling.js';

const steps = proxyActivities<AccountRemovalActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const cluster = proxyActivities<FrozenWorkActivities>({ taskQueue: QUEUES.cluster, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const told = proxyActivities<{ AccountDeletionChangedActivity(change: AccountDeletionChange): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

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

  let progress = deletionBegun(Date.now() * 1000);
  const tell: Tell = async (change) => {
    progress = change(progress);
    if (args.toRoot) await told.AccountDeletionChangedActivity({ ownerId: args.ownerId, progress });
  };
  const part = deletingPart(tell);

  const stopped: string[] = [];
  const stop = async (): Promise<number> => {
    const open = await steps.StopAccountWorkActivity(args);
    stopped.push(...open.map((work) => work.workflowId));
    if (open.length > 0) await tell((current) => workStopping(current, open));
    await Promise.all(open.map((work) => awaitStopped(work, tell, cluster, machineStops)));
    return open.length;
  };

  let apps = 0;
  const destroyApps = async (): Promise<void> => {
    const found = await steps.RemoveAccountAppsActivity(args);
    if (found.length > 0) await tell((current) => partDeleting(current, 'apps', found.length));
    for (const app of found) {
      const destroy = await startChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
      await steps.RemoveAccountAppStartedActivity({ deploymentId: app.deploymentId, workflowId: app.workflowId });
      await destroy.result();
      apps += 1;
      await tell(appRemoved);
    }
  };

  try {
    await steps.MarkAccountRemovingActivity(args);
    await stop();
    done.push('workflows');
    const projects = await part('projects', async () => {
      const found = await steps.RemoveAccountProjectsActivity(args);
      for (const projectId of found) await steps.DeleteAccountProjectActivity({ ownerId: args.ownerId, projectId });
      return found;
    }, (found) => found.length);
    done.push('projects');
    const repositories = await part('repositories', () => steps.RemoveAccountRepositoriesActivity(args), (removed) => (removed ? 1 : 0));
    done.push('repositories');
    if (args.keepRunsFor) await steps.RemoveAccountKeepRunsActivity({ ownerId: args.ownerId, keepRunsFor: args.keepRunsFor });
    await destroyApps();
    await tell((current) => partDeleted(current, 'apps', 0));
    done.push('apps');
    await part('workspaces', () => steps.RemoveAccountWorkspacesActivity(args), (said) => said.split('\n').filter((line) => /\bdeleted\b/.test(line)).length);
    done.push('workspaces');
    const secrets = await part('secrets', () => steps.RemoveAccountSecretsActivity(args), (count) => count);
    done.push('secrets');
    while ((await stop()) > 0) {
      await destroyApps();
      await steps.RemoveAccountWorkspacesActivity(args);
    }
    const mesh = await steps.RemoveAccountMeshActivity(args);
    done.push('mesh');
    const records = await part('records', () => steps.RemoveAccountRecordsActivity(args), (found) => Object.values(found).reduce((sum, count) => sum + count, 0));
    done.push('records');
    await tell((current) => deletionEnded(current, { phase: 'deleted' }));
    return { stopped, projects, apps, secrets, meshDevices: mesh.devices, repositories, records };
  } catch (err) {
    await tell((current) => deletionStuck(current, innermostMessage(err)));
    throw err;
  }
}
