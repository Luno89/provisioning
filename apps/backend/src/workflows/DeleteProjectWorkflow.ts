import { defineQuery, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { destroyEach } from './project-apps.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import type { DeleteProjectArgs, FrozenWorkActivities, ProjectDeletionActivities } from '../activities/DeleteProjectActivities.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { ownerIn } from '../platform/lib/workflow-owner.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<ProjectDeletionActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const cluster = proxyActivities<FrozenWorkActivities>({ taskQueue: QUEUES.cluster, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const told = proxyActivities<{ EngineGroveChangedActivity(args: { ownerId: string }): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: { maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

export const projectDeletionProgressQuery = defineQuery<ProjectRemovalStep[]>(PROJECT_REMOVAL_PROGRESS_QUERY);

export interface ProjectDeleted {
  stopped: string[];
  restarted: string[];
  apps: number;
  sweeps: number;
  archived: boolean;
  repositories: string[];
  files: number;
  records: Record<string, number>;
}

const destroyApps = async (args: DeleteProjectArgs): Promise<number> => destroyEach(await steps.RemoveProjectAppsActivity(args), steps);

export async function DeleteProjectWorkflow(args: DeleteProjectArgs): Promise<ProjectDeleted> {
  const done: ProjectRemovalStep[] = [];
  setHandler(projectDeletionProgressQuery, () => [...done]);

  const stopped = await steps.StopProjectWorkActivity(args);
  const restarted = (await cluster.AwaitProjectWorkActivity({ workflowIds: stopped })).restarted;
  done.push('workflows');
  let apps = await destroyApps(args);
  done.push('apps');
  await steps.RemoveProjectWorkspacesActivity(args);
  done.push('workspaces');
  await steps.RemoveProjectSecretsActivity(args);
  done.push('secrets');

  let sweeps = 0;
  for (;;) {
    sweeps += 1;
    const pass = await steps.SweepProjectActivity(args);
    if (pass.open.length > 0) {
      stopped.push(...pass.open);
      restarted.push(...(await cluster.AwaitProjectWorkActivity({ workflowIds: pass.open })).restarted);
    }
    if (pass.apps > 0) apps += await destroyApps(args);
    if (pass.open.length === 0 && pass.apps === 0 && pass.deleted === 0) break;
  }

  const ran = { stopped, restarted: [...new Set(restarted)], apps, sweeps };
  if (args.mode === 'archive') {
    await steps.ArchiveProjectActivity(args);
    await tellOwner();
    return { ...ran, archived: true, repositories: [], files: 0, records: {} };
  }
  const repositories = await steps.RemoveProjectRepositoriesActivity(args);
  done.push('repositories');
  const files = await steps.RemoveProjectFilesActivity(args);
  done.push('files');
  const records = await steps.RemoveProjectRecordsActivity(args);
  done.push('records');
  await tellOwner();
  return { ...ran, archived: false, repositories, files, records };
}

async function tellOwner(): Promise<void> {
  const owner = ownerIn(workflowInfo().typedSearchAttributes);
  if (owner) await told.EngineGroveChangedActivity({ ownerId: owner }).catch(ignore('the browser reads its trees again when it next looks; this only tells it sooner'));
}
