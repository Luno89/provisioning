import { defineQuery, proxyActivities, setHandler } from '@temporalio/workflow';
import { DESTROY_RETRY } from '../lib/activity-retry.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../lib/project-removal.js';
import type { ProjectRemovalActivities, RemoveProjectArgs } from '../activities/RemoveProjectActivities.js';

const steps = proxyActivities<ProjectRemovalActivities>({
  retry: DESTROY_RETRY,
  startToCloseTimeout: '10 minutes',
  heartbeatTimeout: '2 minutes',
});

export const projectRemovalProgressQuery = defineQuery<ProjectRemovalStep[]>(PROJECT_REMOVAL_PROGRESS_QUERY);

export interface ProjectRemoved {
  stoppedWorkflows: number;
  workspaces: number;
  secrets: { workspace: boolean; readers: number };
  repositories: string[];
  records: Record<string, number>;
}

export async function RemoveProjectWorkflow(args: RemoveProjectArgs): Promise<ProjectRemoved> {
  const done: ProjectRemovalStep[] = [];
  setHandler(projectRemovalProgressQuery, () => [...done]);

  const stoppedWorkflows = await steps.RemoveProjectWorkflowsActivity(args);
  done.push('workflows');
  const workspaces = await steps.RemoveProjectWorkspacesActivity(args);
  done.push('workspaces');
  const secrets = await steps.RemoveProjectSecretsActivity(args);
  done.push('secrets');
  const repositories = await steps.RemoveProjectRepositoriesActivity(args);
  done.push('repositories');
  const records = await steps.RemoveProjectRecordsActivity(args);
  done.push('records');

  return { stoppedWorkflows, workspaces, secrets, repositories, records };
}
