import { proxyActivities, sleep, log } from '@temporalio/workflow';
import type { CheckWorkloadArgs, CheckWorkloadResult } from '../activities/CheckWorkloadActivity.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';
import { ACTIVITY_RETRY } from '../platform/lib/activity-retry.js';

const { CheckWorkloadActivity } = proxyActivities<{
  CheckWorkloadActivity: (args: CheckWorkloadArgs) => Promise<CheckWorkloadResult>;
}>({ retry: ACTIVITY_RETRY, ...LIVE_ACTIVITY });

const ROLLOUT_INTERVAL = '30 seconds';

export interface WorkloadVerdict {
  workload: 'healthy' | 'unhealthy';
  workloadReason: string;
}

export async function awaitWorkload(args: CheckWorkloadArgs): Promise<WorkloadVerdict> {
  const name = args.namespace ?? args.name;
  let told: string | undefined;
  for (;;) {
    const { health, reason } = await CheckWorkloadActivity({ ...args, ...(told === undefined ? {} : { told }) });

    if (health === 'healthy') {
      log.info(`Workload for ${name} is running`);
      return { workload: 'healthy', workloadReason: '' };
    }
    if (health === 'unhealthy') {
      log.warn(`Workload for ${name} is not running: ${reason}`);
      return { workload: 'unhealthy', workloadReason: reason };
    }
    if (health === 'starting') told = reason;
    await sleep(ROLLOUT_INTERVAL);
  }
}
