import { log, proxyActivities } from '@temporalio/workflow';
import type { ProvisionClusterArgs, ProvisionClusterResult } from '../activities/ProvisionClusterActivity.js';
import { provisionedFrom, type ProvisionedCluster } from '../infrastructure/lib/provisioned-cluster.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';

const logger = log;
const { ProvisionClusterActivity } = proxyActivities<{
  ProvisionClusterActivity: (args: ProvisionClusterArgs) => Promise<ProvisionClusterResult>;
}>({
  ...LIVE_ACTIVITY,
  retry: { maximumAttempts: 3 },
});

export async function ClusterProvisionWorkflow(args: ProvisionClusterArgs): Promise<ProvisionedCluster> {
  logger.info(`Starting ClusterProvisionWorkflow for cluster: ${args.name}`);

  const result = await ProvisionClusterActivity(args);

  logger.info(`ClusterProvisionWorkflow completed for cluster ${args.name}`);
  return provisionedFrom(result, args.logFile);
}
