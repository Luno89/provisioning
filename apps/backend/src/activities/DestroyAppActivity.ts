/**
 * DestroyAppActivity - destroys the CDKTF-managed application stack and k8s namespace.
 */
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';

export interface DestroyAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  logFile: string;
  deploymentId?: string;
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
  
  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = (args.provider === 'k3d' || isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : undefined;

  const stackName = `app-${physicalName}-${args.deploymentId || 'default'}`;
  const logFile = args.logFile;

  // 1. CDKTF destroy
  await infra.destroy(stackName, {
    logFile,
    env: {
      STACK_TYPE: 'app',
      CLUSTER_NAME: physicalName,
      DEPLOYMENT_STRATEGY: args.strategy,
      DEPLOYMENT_ID: args.deploymentId || 'default',
      KUBECONFIG: kubeconfigPath || '',
      KUBECONFIG_CONTEXT: (args.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : '',
    },
  });

  // 2. Delete Kubernetes namespace
  await infra.runKubectl(['delete', 'namespace', sanitizedName, '--wait=false'], kubeconfigPath);

  return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
