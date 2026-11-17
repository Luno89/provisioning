import {
  StorageAdapter, namespaceOf, type MachineOfCluster, type Reach,
} from '../infrastructure/index.js';
import type { ClusterSteps } from './cluster-steps.js';
import { handedReach } from './handed-reach.js';
import { appServiceType, appStackName, NO_STACK_ID, placedOnPool } from '../infrastructure/index.js';
import { ApplicationFailure } from '@temporalio/common';
import { applyWatched } from './watched-apply.js';

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

export async function ResizeDiskActivity(args: ResizeDiskArgs, steps: ClusterSteps, signal?: AbortSignal): Promise<ResizeDiskResult> {
  const reach = handedReach(args);
  const physicalName = args.clusterName;
  if (!args.deploymentId) throw ApplicationFailure.nonRetryable(`${args.name} ${NO_STACK_ID}`);
  const deploymentId = args.deploymentId;

  const env: Record<string, string> = {
    STACK_TYPE: 'app',
    CLUSTER_NAME: physicalName,
    DEPLOYMENT_STRATEGY: args.strategy,
    DEPLOYMENT_NAME: namespaceOf(args),
    DEPLOYMENT_ID: deploymentId,
    KUBECONFIG: await steps.access.kubeconfigOf(reach),
    APP_SERVICE_TYPE: appServiceType(placedOnPool(Boolean(steps.access.here.poolName), reach)),
    APP_TYPE: args.appType,
    ...StorageAdapter.getStorageEnv(args.appType, args.strategy, args.storage),
  };

  await applyWatched(steps, appStackName(physicalName, deploymentId), { logFile: args.logFile, env }, { what: args.name, reach, namespaces: [namespaceOf(args)], signal });

  return { status: 'resize_complete', msg: `Disk resize requested for ${args.name}` };
}
