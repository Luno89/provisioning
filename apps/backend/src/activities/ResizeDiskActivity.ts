import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';

export interface ResizeDiskArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  appType: string;
  storage: Record<string, string>;
  logFile: string;
  deploymentId?: string;
}

export interface ResizeDiskResult {
  status: string;
  msg: string;
}

export { resizeDiskActivityMeta } from '../lib/activity-timeouts.js';

export async function ResizeDiskActivity(
  args: ResizeDiskArgs,
): Promise<ResizeDiskResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;
  
  const isMock = isMockCloudProvider(args.provider, hasCloudCredentials);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = isSelfManagedCluster(args.provider, isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : undefined;

  const storageEnv = StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage);

  const deploymentId = args.deploymentId || 'default';

  const env: Record<string, string> = {
    STACK_TYPE: 'app',
    CLUSTER_NAME: physicalName,
    DEPLOYMENT_STRATEGY: args.strategy,
    DEPLOYMENT_NAME: args.name.toLowerCase().replace(/[^a-z0-9]*/g, '-'),
    DEPLOYMENT_ID: deploymentId,
    KUBECONFIG: kubeconfigPath || '',
    KUBECONFIG_CONTEXT: (args.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : '',
    SELF_MANAGED_K8S: isSelfManagedCluster(args.provider, isMock) ? 'true' : 'false',
    APP_TYPE: args.appType,
    ...storageEnv,
  };

  await infra.deploy(`app-${physicalName}-${deploymentId}`, { logFile, env });

  return { status: 'resize_complete', msg: `Disk resize requested for ${args.name}` };
}
