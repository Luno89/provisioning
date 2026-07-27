import { log, proxyActivities } from '@temporalio/workflow';
// import type from the activity file directly (type-only imports are erased by TypeScript, so
// this doesn't pull activity.ts's runtime dependency chain into the workflow bundle — see
// AppDeployWorkflow.ts/DestroyClusterWorkflow.ts for the same pattern) rather than the narrower
// lib/types.ts ClusterTaskArgs — confirmed live that reconstructing a fixed { name, provider,
// logFile } object below (this file's previous shape) silently dropped every field
// ProvisionClusterActivity's `provider === 'remote'` branch needs (remoteHost, remoteUsername,
// remoteSshPrivateKey, remoteSshPort), even though TemporalBridge.provision() built and passed
// them correctly — the workflow was the thing throwing them away.
import type { ProvisionClusterArgs, ProvisionClusterResult } from '../activities/ProvisionClusterActivity.js';
// From lib/activity-timeouts.ts, not the activity file directly — see AppDeployWorkflow.ts for
// why (a value import from an activity file breaks Temporal's webpack workflow bundling).
import { provisionClusterActivityMeta } from '../lib/activity-timeouts.js';

const logger = log;
// provisionClusterActivityMeta.startToCloseTimeout, not a hardcoded '30 minutes' — see
// AppDeployWorkflow.ts for why: every workflow in this file was silently ignoring its own
// activity's declared timeout (80 min here) in favor of a stray 30-minute default.
// maximumAttempts matters more here than anywhere else, because Temporal's default is UNLIMITED
// and this activity CREATES BILLABLE INFRASTRUCTURE on every attempt. Observed live against
// Hetzner: a transient SSH timeout retried the activity, which regenerated the SSH keypair, which
// Terraform treated as a change forcing the VM to be destroyed and rebuilt — so each retry threw
// away the machine it had just paid for and started again, indefinitely. Three attempts is enough
// for a genuine provider blip while bounding both the cost and the time-to-diagnosis.
const { ProvisionClusterActivity } = proxyActivities<{
  ProvisionClusterActivity: (args: ProvisionClusterArgs) => Promise<ProvisionClusterResult>;
}>({
  startToCloseTimeout: provisionClusterActivityMeta.startToCloseTimeout,
  retry: { maximumAttempts: 3 },
});

/**
 * Workflow that triggers a ProvisionClusterActivity.
 */
export async function ClusterProvisionWorkflow(args: ProvisionClusterArgs): Promise<{
  status: string;
  msg: string;
  kubeconfig?: string;
  logFile?: string;
  // provider === 'hetzner' only. Forwarded verbatim from the activity — see the file header for
  // the exact failure mode this guards against: a workflow that rebuilds a fixed result object
  // silently drops fields the caller depends on, and TemporalBridge cannot destroy (or stop
  // paying for) a VM whose id and access key never made it back out of the workflow.
  hetznerServerId?: string;
  createdHost?: string;
  createdUsername?: string;
  createdPrivateKey?: string;
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
    };
  } catch (err: any) {
    logger.error(`ClusterProvisionWorkflow failed: ${err.message}`);
    return { status: 'failed', msg: err.message || 'Unknown failure' };
  }
}
