/**
 * ResizeDiskActivity - triggers a k8s volume resize for a specific deployment.
 */
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

import { InfrastructureService } from '../services/InfrastructureService.js';
import { StorageAdapter } from '../services/StorageAdapter.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';

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

export const resizeDiskActivityMeta = {
  name: 'ResizeDiskActivity',
  startToCloseTimeout: '80 minutes',
};

export async function ResizeDiskActivity(
  args: ResizeDiskArgs,
): Promise<ResizeDiskResult> {
  const infra = new InfrastructureService();
  const logFile = args.logFile;
  
  const isMock = args.provider !== 'k3d' && !hasCloudCredentials(args.provider);
  const physicalName = isMock ? `mock-${args.provider}-${args.clusterName}` : args.clusterName;
  const kubeconfigPath = (args.provider === 'k3d' || isMock)
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
    APP_TYPE: args.appType,
    ...storageEnv,
  };

  await infra.deploy(`app-${physicalName}-${deploymentId}`, { logFile, env });

  return { status: 'resize_complete', msg: `Disk resize requested for ${args.name}` };
}
