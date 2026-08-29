import { log, proxyActivities } from '@temporalio/workflow';
import type { ProvisionClusterArgs, ProvisionClusterResult } from '../activities/ProvisionClusterActivity.js';
import type { ClusterCapacity } from '../lib/cluster-capacity.js';
import { provisionClusterActivityMeta } from '../lib/activity-timeouts.js';

const logger = log;
const { ProvisionClusterActivity } = proxyActivities<{
  ProvisionClusterActivity: (args: ProvisionClusterArgs) => Promise<ProvisionClusterResult>;
}>({
  startToCloseTimeout: provisionClusterActivityMeta.startToCloseTimeout,
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

  try {
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
  } catch (err: any) {
    logger.error(`ClusterProvisionWorkflow failed: ${err.message}`);
    return { status: 'failed', msg: err.message || 'Unknown failure' };
  }
}
