/**
 * DestroyClusterActivity
 *
 * Destroys the physical k3d cluster, runs any remaining CDKTF destroy,
 * and cleans up kubeconfig leftovers.
 */
import fs from 'fs/promises';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';

export interface DestroyClusterArgs {
  name: string;
  provider: string;
  logFile: string;
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

  // 1. Destroy infrastructure stack
  await infra.destroy(args.name, {
    logFile,
    env: {
      STACK_TYPE: 'cluster',
      ENV: args.provider,
      CLUSTER_NAME: args.name,
    },
  });

  // 2. Delete the physical k3d cluster if applicable
  if (args.provider === 'k3d') {
    await infra.deleteLocalCluster(args.name, { logFile });
    try {
      await fs.rm(`/tmp/kubeconfig-${args.name}`, { force: true });
    } catch {}
  }

  return { status: 'destroyed', msg: `Cluster ${args.name} destroyed` };
}
