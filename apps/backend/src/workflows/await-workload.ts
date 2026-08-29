import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type { CheckWorkloadArgs, CheckWorkloadResult } from '../activities/CheckWorkloadActivity.js';
import { checkWorkloadActivityMeta } from '../lib/activity-timeouts.js';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';

const { CheckWorkloadActivity } = proxyActivities<{
  CheckWorkloadActivity: (args: CheckWorkloadArgs) => Promise<CheckWorkloadResult>;
}>({ retry: ACTIVITY_RETRY, startToCloseTimeout: checkWorkloadActivityMeta.startToCloseTimeout });

const ROLLOUT_CHECKS = 60;
const ROLLOUT_INTERVAL = '30 seconds';

export interface WorkloadVerdict {
  workload: 'healthy' | 'unhealthy' | 'starting';
  workloadReason: string;
}

export async function awaitWorkload(name: string, clusterId: string): Promise<WorkloadVerdict> {
  for (let i = 0; i < ROLLOUT_CHECKS; i++) {
    const { health, reason } = await CheckWorkloadActivity({ name, clusterId });

    if (health === 'healthy') {
      log.info(`Workload for ${name} is running`);
      return { workload: 'healthy', workloadReason: '' };
    }
    if (health === 'unhealthy') {
      log.warn(`Workload for ${name} is not running: ${reason}`);
      return { workload: 'unhealthy', workloadReason: reason };
    }
    await sleep(ROLLOUT_INTERVAL);
  }
  log.warn(`Workload for ${name} had not started within the rollout window; leaving it to the reconciler`);
  return { workload: 'starting', workloadReason: 'still starting when the rollout window ended' };
}
