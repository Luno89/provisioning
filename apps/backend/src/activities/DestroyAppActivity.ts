/**
 * DestroyAppActivity - destroys the CDKTF-managed application stack and k8s namespace.
 */
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';

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

// Moved to lib/activity-timeouts.ts — see that file for why (workflow files must never import a
// VALUE from an activity file, only `import type`).
export { destroyAppActivityMeta } from '../lib/activity-timeouts.js';

export async function DestroyAppActivity(
  args: DestroyAppArgs,
): Promise<DestroyAppResult> {
  const infra = new InfrastructureService();
  const sanitizedName = args.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  
  // See DeployAppActivity.ts's identical comment — 'remote' is never a mock-cloud scenario.
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  // See DeployAppActivity.ts's identical comment — 'remote' clusters also use this exact path.
  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
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
      SELF_MANAGED_K8S: isSelfManagedCluster(args.provider, isMock) ? 'true' : 'false',
    },
  });

  // 2. Delete Kubernetes namespace and wait for resources to fully terminate
  await infra.waitForNamespaceDeletion(sanitizedName, kubeconfigPath);

  return { status: 'destroyed', msg: `App ${args.name} destroyed` };
}
