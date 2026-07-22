/**
 * DestroyClusterActivity
 *
 * Destroys the physical k3d cluster, runs any remaining CDKTF destroy,
 * and cleans up kubeconfig leftovers.
 */
import fs from 'fs/promises';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';

export interface DestroyClusterArgs {
  name: string;
  provider: string;
  logFile: string;
  gpuEnabled?: boolean;
}

export interface DestroyClusterResult {
  status: string;
  msg: string;
}

export const destroyClusterActivityMeta = {
  name: 'DestroyClusterActivity',
  startToCloseTimeout: '60 minutes',
};

export async function DestroyClusterActivity(
  args: DestroyClusterArgs,
): Promise<DestroyClusterResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;

  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.name}` : args.name;
  const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;

  // GPU-enabled clusters attach to the shared management cluster rather than owning a physical
  // cluster (see ProvisionClusterActivity) — there's nothing k3d-shaped to tear down. App-level
  // destroy already cleans up the namespaces/resources an app created; just drop the kubeconfig.
  if (args.gpuEnabled) {
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
    return { status: 'destroyed', msg: `Cluster ${args.name} detached from the management cluster` };
  }

  // 1. Destroy infrastructure stack
  await infra.destroy(physicalName, {
    logFile,
    env: {
      STACK_TYPE: 'cluster',
      ENV: isMock ? 'local' : args.provider,
      CLUSTER_NAME: physicalName,
      KUBECONFIG_PATH: kubeconfigPath,
    },
  });

  // 2. Delete the physical k3d cluster if applicable
  if (args.provider === 'k3d' || isMock) {
    await infra.deleteLocalCluster(physicalName, { logFile });
    await infra.disconnectNginxFromNetwork(physicalName);
    try {
      await fs.rm(kubeconfigPath, { force: true });
    } catch {}
  }

  return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
