import { log, proxyActivities } from '@temporalio/workflow';
import type { ProvisionClusterArgs, ProvisionClusterResult } from '../activities/ProvisionClusterActivity.js';
import type { ClusterCapacity } from '../infrastructure/index.js';
import { LIVE_ACTIVITY } from '../platform/lib/activity-liveness.js';

const logger = log;
const { ProvisionClusterActivity } = proxyActivities<{
  ProvisionClusterActivity: (args: ProvisionClusterArgs) => Promise<ProvisionClusterResult>;
}>({
  ...LIVE_ACTIVITY,
  retry: { maximumAttempts: 3 },
});

export async function ClusterProvisionWorkflow(args: ProvisionClusterArgs): Promise<{
  status: string;
  msg: string;
  kubeconfig?: string;
  logFile?: string;
  hetznerServerId?: string;
  createdHost?: string;
  createdUsername?: string;
  createdPrivateKey?: string;
  capacity?: ClusterCapacity;
}> {
  logger.info(`Starting ClusterProvisionWorkflow for cluster: ${args.name}`);

  const result = await ProvisionClusterActivity(args);

  logger.info(`ClusterProvisionWorkflow completed for cluster ${args.name}`);
  return {
    status: 'healthy',
    msg: result.msg || 'Cluster provisioned',
    kubeconfig: result.kubeconfigPath,
    logFile: args.logFile,
    ...(result.hetznerServerId ? { hetznerServerId: result.hetznerServerId } : {}),
    ...(result.createdHost ? { createdHost: result.createdHost } : {}),
    ...(result.createdUsername ? { createdUsername: result.createdUsername } : {}),
    ...(result.createdPrivateKey ? { createdPrivateKey: result.createdPrivateKey } : {}),
    ...(result.capacity ? { capacity: result.capacity } : {}),
  };
}
