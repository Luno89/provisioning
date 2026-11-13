import { ActivityCancellationType, proxyActivities } from '@temporalio/workflow';

export interface Straggling {
  StraggleActivity(args: { ownerId: string; projectId?: string | undefined }): Promise<string[]>;
}

const steps = proxyActivities<Straggling>({
  startToCloseTimeout: '30 days',
  heartbeatTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
  cancellationType: ActivityCancellationType.ABANDON,
});

export async function StragglerWorkflow(args: { ownerId: string; projectId?: string | undefined }): Promise<string[]> {
  return steps.StraggleActivity(args);
}
