import { startChild } from '@temporalio/workflow';
import { executeDestroyAppWorkflow } from './DestroyAppWorkflow.js';
import type { AppToDestroy } from '../activities/RemoveProjectActivities.js';

export interface AppStarted {
  RemoveProjectAppStartedActivity(args: { deploymentId: string; workflowId: string }): Promise<void>;
}

export async function destroyEach(apps: readonly AppToDestroy[], steps: AppStarted): Promise<number> {
  for (const app of apps) {
    const destroy = await startChild(executeDestroyAppWorkflow, { workflowId: app.workflowId, taskQueue: app.taskQueue, args: [app.args] });
    await steps.RemoveProjectAppStartedActivity({ deploymentId: app.deploymentId, workflowId: app.workflowId });
    await destroy.result();
  }
  return apps.length;
}
