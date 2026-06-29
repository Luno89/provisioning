/**
 * DestroyAppActivity - destroys the CDKTF-managed application stack and k8s namespace.
 */
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';

export interface DestroyAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  logFile: string;
}

export interface DestroyAppResult {
  status: string;
  msg: string;
}

export const destroyAppActivityMeta = {
  name: 'DestroyAppActivity',
  startToCloseTimeout: '60 minutes',
};

export async function DestroyAppActivity(
  args: DestroyAppArgs,
): Promise<DestroyAppResult> {
  const infra = new InfrastructureService();
  const sanitizedName = args.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const stackName = `app-${args.clusterName}-${uuidv4().slice(0, 8)}`;
  const logFile = args.logFile;

  // 1. CDKTF destroy
  await infra.destroy(stackName, {
    logFile,
    env: {
      STACK_TYPE: 'app',
      CLUSTER_NAME: args.clusterName,
      DEPLOYMENT_STRATEGY: args.strategy,
    },
  });

  // 2. Delete Kubernetes namespace
  const ctx = args.provider === 'k3d' ? `k3d-${args.clusterName}` : undefined;
  await infra.runKubectl(['delete', 'namespace', sanitizedName, '--wait=false']);

  return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
