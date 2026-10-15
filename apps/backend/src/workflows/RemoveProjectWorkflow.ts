import { defineQuery, executeChild, proxyActivities, setHandler, sleep } from '@temporalio/workflow';
import { DESTROY_RETRY } from '../lib/activity-retry.js';
import { ACTIVITY_STOP_GRACE_MS } from '../lib/account-removal.js';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../lib/project-removal.js';
import type { ProjectRemovalActivities, RemoveProjectArgs } from '../activities/RemoveProjectActivities.js';
import { LIVE_ACTIVITY } from '../lib/activity-liveness.js';

const steps = proxyActivities<ProjectRemovalActivities>({
  retry: DESTROY_RETRY,
  ...LIVE_ACTIVITY,
});

export const projectRemovalProgressQuery = defineQuery<ProjectRemovalStep[]>(PROJECT_REMOVAL_PROGRESS_QUERY);

export interface ProjectRemoved {
  stoppedWorkflows: number;
  apps: number;
  workspaces: number;
  secrets: { workspace: boolean; readers: number };
  repositories: string[];
  records: Record<string, number>;
}

export async function RemoveProjectWorkflow(args: RemoveProjectArgs): Promise<ProjectRemoved> {
  const done: ProjectRemovalStep[] = [];
  setHandler(projectRemovalProgressQuery, () => [...done]);

  const stoppedWorkflows = await steps.RemoveProjectWorkflowsActivity(args);
  if (stoppedWorkflows > 0) await sleep(ACTIVITY_STOP_GRACE_MS);
  done.push('workflows');
  const apps = await steps.RemoveProjectAppsActivity(args);
  for (const app of apps) await executeChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
  done.push('apps');
  const workspaces = await steps.RemoveProjectWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveProjectSecretsActivity(args);
  done.push('secrets');
  const repositories = await steps.RemoveProjectRepositoriesActivity(args);
  done.push('repositories');
  const records = await steps.RemoveProjectRecordsActivity(args);
  done.push('records');

  return { stoppedWorkflows, apps: apps.length, workspaces, secrets, repositories, records };
}
