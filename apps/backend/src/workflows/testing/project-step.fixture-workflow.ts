import { proxyActivities } from '@temporalio/workflow';
import { LIVE_ACTIVITY } from '../../platform/lib/activity-liveness.js';

export interface ProjectStep {
  ProjectStepActivity(args: { ownerId: string; projectId: string }): Promise<string>;
}

const steps = proxyActivities<ProjectStep>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 1 } });

export async function ProjectStepWorkflow(args: { ownerId: string; projectId: string }): Promise<string> {
  return steps.ProjectStepActivity(args);
}
