import { log, proxyActivities } from '@temporalio/workflow';
import type { ClusterTaskArgs, ClusterTaskResult } from '../lib/types';

const logger = log;
const { ProvisionClusterActivity } = proxyActivities<{
  ProvisionClusterActivity: (args: { name: string; provider: string; logFile: string }) => Promise<{ status: string; kubeconfigPath: string; msg: string; logFile: string }>;
}>({ startToCloseTimeout: '30 minutes' });

/**
 * Workflow that triggers a ProvisionClusterActivity.
 */
export async function ClusterProvisionWorkflow(args: ClusterTaskArgs): Promise<ClusterTaskResult> {
  logger.info(`Starting ClusterProvisionWorkflow for cluster: ${args.name}`);

  try {
    const result = await ProvisionClusterActivity({
      name: args.name,
      provider: args.provider,
      logFile: args.logFile,
    });

    logger.info(`ClusterProvisionWorkflow completed for cluster ${args.name}`);
    return {
      status: 'healthy',
      msg: result.msg || 'Cluster provisioned',
      kubeconfig: result.kubeconfigPath,
      logFile: args.logFile,
    };
  } catch (err: any) {
    logger.error(`ClusterProvisionWorkflow failed: ${err.message}`);
    return { status: 'failed', msg: err.message || 'Unknown failure' };
  }
}
