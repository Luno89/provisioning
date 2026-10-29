import { continueAsNew, log, proxyActivities, sleep } from '@temporalio/workflow';
import type * as watch from '../activities/DependencyWatchActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
export { DEPENDENCY_WATCH_ID } from '../instances/lib/dependency-findings.js';

const { DependencyWatchActivity } = proxyActivities<typeof watch>({ ...LIVE_ACTIVITY, retry: { maximumAttempts: 5 } });

export async function DependencyWatchWorkflow(): Promise<void> {
  try {
    const checked = await DependencyWatchActivity();
    log.info('dependencies checked', checked);
  } catch (error) {
    log.warn('the dependency check failed and runs again tomorrow', { error: (error as Error).message });
  }
  await sleep('1 day');
  await continueAsNew<typeof DependencyWatchWorkflow>();
}
