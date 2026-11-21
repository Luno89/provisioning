import { defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { destroyEach } from './project-apps.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import {
  appRemoved,
  deletionBegun,
  deletionEnded,
  deletionStuck,
  partDeleted,
  partDeleting,
  workStopping,
  serviceBack,
  serviceDown,
  SERVICE_BACK_SIGNAL,
  SERVICE_DOWN_SIGNAL,
  type ServiceDown,
  type DeletionProgress,
  type OpenWork,
} from '../projects/lib/project-deletion.js';
import type { DeleteProjectArgs, FrozenWorkActivities, ProjectDeletionActivities } from '../activities/DeleteProjectActivities.js';
import { QUEUES } from '../platform/lib/work-places.js';
import { awaitStopped, deletingPart, innermostMessage } from './deletion-telling.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { ownerIn } from '../platform/lib/workflow-owner.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<ProjectDeletionActivities>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const cluster = proxyActivities<FrozenWorkActivities>({ taskQueue: QUEUES.cluster, retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const told = proxyActivities<{ ProjectDeletionChangedActivity(args: { ownerId: string; projectId: string; progress: DeletionProgress }): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

const grove = proxyActivities<{ EngineGroveChangedActivity(args: { ownerId: string }): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: { maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

export const projectDeletionProgressQuery = defineQuery<ProjectRemovalStep[]>(PROJECT_REMOVAL_PROGRESS_QUERY);

const serviceDownSignal = defineSignal<[ServiceDown]>(SERVICE_DOWN_SIGNAL);
const serviceBackSignal = defineSignal<[string]>(SERVICE_BACK_SIGNAL);

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

export async function DeleteProjectWorkflow(args: DeleteProjectArgs): Promise<ProjectDeleted> {
  const done: ProjectRemovalStep[] = [];
  setHandler(projectDeletionProgressQuery, () => [...done]);
  const owner = ownerIn(workflowInfo().typedSearchAttributes);

  let progress = deletionBegun(Date.now() * 1000);
  const tell = async (change: (current: DeletionProgress) => DeletionProgress): Promise<void> => {
    progress = change(progress);
    if (owner) await told.ProjectDeletionChangedActivity({ ownerId: owner, projectId: args.projectId, progress });
  };

  setHandler(serviceDownSignal, (down) => tell((current) => serviceDown(current, down)));
  setHandler(serviceBackSignal, (step) => tell((current) => serviceBack(current, step)));

  const stopped: string[] = [];
  const restarted: string[] = [];
  const stop = async (open: readonly OpenWork[]): Promise<void> => {
    if (open.length === 0) return;
    stopped.push(...open.map((work) => work.workflowId));
    await tell((current) => workStopping(current, open));
    await Promise.all(open.map(async (work) => { restarted.push(...(await awaitStopped(work, tell, cluster))); }));
  };

  const part = deletingPart(tell);

  const destroyApps = async (): Promise<number> => {
    const apps = await steps.RemoveProjectAppsActivity(args);
    if (apps.length === 0) return 0;
    await tell((current) => partDeleting(current, 'apps', apps.length));
    for (const app of apps) {
      await destroyEach([app], steps);
      await tell(appRemoved);
    }
    return apps.length;
  };

  try {
    await stop(await steps.StopProjectWorkActivity(args));
    done.push('workflows');
    await steps.RemoveProjectWebhookActivity(args);
    let apps = await destroyApps();
    await tell((current) => partDeleted(current, 'apps', 0));
    done.push('apps');
    await part('workspaces', () => steps.RemoveProjectWorkspacesActivity(args), (count) => count);
    done.push('workspaces');
    await part('secrets', () => steps.RemoveProjectSecretsActivity(args), (found) => (found.workspace ? 1 : 0) + found.readers);
    done.push('secrets');

    let sweeps = 0;
    for (;;) {
      sweeps += 1;
      const pass = await steps.SweepProjectActivity(args);
      await stop(pass.open);
      if (pass.apps > 0) apps += await destroyApps();
      if (pass.workspaces > 0) await tell((current) => partDeleted(current, 'workspaces', pass.workspaces));
      if (pass.secrets > 0) await tell((current) => partDeleted(current, 'secrets', pass.secrets));
      if (pass.open.length === 0 && pass.apps === 0 && pass.workspaces === 0 && pass.secrets === 0) break;
    }

    const ran = { stopped, restarted: [...new Set(restarted)], apps, sweeps };
    if (args.mode === 'archive') {
      const { keptUntil } = await steps.ArchiveProjectActivity(args);
      await tell((current) => deletionEnded(current, { phase: 'archived', keptUntil }));
      await tellGrove(owner);
      return { ...ran, archived: true, repositories: [], files: 0, records: {} };
    }
    const repositories = await part('repositories', () => steps.RemoveProjectRepositoriesActivity(args), (found) => found.length);
    done.push('repositories');
    const files = await part('files', () => steps.RemoveProjectFilesActivity(args), (count) => count);
    done.push('files');
    const records = await part('records', () => steps.RemoveProjectRecordsActivity(args), (found) => Object.values(found).reduce((sum, count) => sum + count, 0));
    done.push('records');
    await tell((current) => deletionEnded(current, { phase: 'deleted' }));
    await tellGrove(owner);
    return { ...ran, archived: false, repositories, files, records };
  } catch (err) {
    await tell((current) => deletionStuck(current, innermostMessage(err)));
    throw err;
  }
}

async function tellGrove(owner: string | undefined): Promise<void> {
  if (owner) await grove.EngineGroveChangedActivity({ ownerId: owner }).catch(ignore('the browser reads its trees again when it next looks; this only tells it sooner'));
}
