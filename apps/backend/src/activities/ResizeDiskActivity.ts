import {
  StorageAdapter, namespaceOf, type MachineOfCluster, type Reach,
} from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';
import { appServiceType, placedOnPool } from '../monitoring/index.js';

export interface ResizeDiskArgs {
  name: string;
  namespace?: string | undefined;
  clusterId: string;
  reach?: Reach | undefined;
  machine?: MachineOfCluster | undefined;
  clusterName: string;
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

export async function ResizeDiskActivity(args: ResizeDiskArgs, steps: ClusterSteps): Promise<ResizeDiskResult> {
  const reach = handedReach(args);
  const physicalName = args.clusterName;
  const deploymentId = args.deploymentId || 'default';

  const env: Record<string, string> = {
    STACK_TYPE: 'app',
    CLUSTER_NAME: physicalName,
    DEPLOYMENT_STRATEGY: args.strategy,
    DEPLOYMENT_NAME: namespaceOf(args),
    DEPLOYMENT_ID: deploymentId,
    KUBECONFIG: await steps.access.kubeconfigOf(reach),
    APP_SERVICE_TYPE: appServiceType(placedOnPool(process.env, reach)),
    APP_TYPE: args.appType,
    ...StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage),
  };

  await steps.infra.deploy(`app-${physicalName}-${deploymentId}`, { logFile: args.logFile, env });

  return { status: 'resize_complete', msg: `Disk resize requested for ${args.name}` };
}
