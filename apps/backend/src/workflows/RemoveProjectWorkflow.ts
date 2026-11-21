import { defineQuery, executeChild, patched, proxyActivities, setHandler, sleep, workflowInfo } from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';
import { DESTROYS_NAMED_ONCE_STARTED, FENCED_REMOVAL, UNFENCED_STOP_GRACE_MS } from '../accounts/lib/account-removal.js';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { destroyEach } from './project-apps.js';
import { PROJECT_FILES_PATCH, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import type { ProjectRemovalActivities, RemoveProjectArgs } from '../activities/RemoveProjectActivities.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { DEFAULT_STREAM_TASK_QUEUE, GROVE_CHANGED_PATCH } from '../engine-host/temporal/contracts.js';
import { ownerIn } from '../platform/lib/workflow-owner.js';
import { ignore } from '@koala/engine-core/failures';

const steps = proxyActivities<ProjectRemovalActivities>({
  retry: ACTIVITY_RETRY,
  ...LIVE_ACTIVITY,
});

const told = proxyActivities<{ EngineGroveChangedActivity(args: { ownerId: string }): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: { maximumAttempts: 3 },
  ...LIVE_ACTIVITY,
});

export const projectRemovalProgressQuery = defineQuery<ProjectRemovalStep[]>(PROJECT_REMOVAL_PROGRESS_QUERY);

export interface ProjectRemoved {
  stoppedWorkflows: number;
  apps: number;
  workspaces: number;
  secrets: { workspace: boolean; readers: number };
  repositories: string[];
  files: number;
  records: Record<string, number>;
}

export async function RemoveProjectWorkflow(args: RemoveProjectArgs): Promise<ProjectRemoved> {
  const done: ProjectRemovalStep[] = [];
  setHandler(projectRemovalProgressQuery, () => [...done]);

  const fenced = patched(FENCED_REMOVAL);
  if (fenced) await steps.RemoveProjectFenceActivity(args);
  const stoppedWorkflows = await steps.RemoveProjectWorkflowsActivity(args);
  if (!fenced && stoppedWorkflows > 0) await sleep(UNFENCED_STOP_GRACE_MS);
  done.push('workflows');
  let repositories: string[] = [];
  if (fenced) {
    repositories = await steps.RemoveProjectRepositoriesActivity(args);
    done.push('repositories');
  }
  const apps = await steps.RemoveProjectAppsActivity(args);
  if (patched(DESTROYS_NAMED_ONCE_STARTED)) await destroyEach(apps, steps);
  else for (const app of apps) await executeChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
  done.push('apps');
  const workspaces = await steps.RemoveProjectWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveProjectSecretsActivity(args);
  done.push('secrets');
  if (!fenced) {
    repositories = await steps.RemoveProjectRepositoriesActivity(args);
    done.push('repositories');
  }
  const files = patched(PROJECT_FILES_PATCH) ? await steps.RemoveProjectFilesActivity(args) : 0;
  if (patched(PROJECT_FILES_PATCH)) done.push('files');
  const records = await steps.RemoveProjectRecordsActivity(args);
  done.push('records');
  if (fenced) await steps.RemoveProjectFenceEndActivity(args);
  const owner = ownerIn(workflowInfo().typedSearchAttributes);
  if (owner && patched(GROVE_CHANGED_PATCH)) await told.EngineGroveChangedActivity({ ownerId: owner }).catch(ignore('the browser reads its trees again when it next looks; this only tells it sooner'));

  return { stoppedWorkflows, apps: apps.length, workspaces, secrets, repositories, files, records };
}
