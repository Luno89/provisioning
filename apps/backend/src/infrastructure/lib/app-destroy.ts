import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import type { HandOver, Reach } from './cluster-places.js';

export interface DestroyAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  strategy: string;
  logFile: string;
  deploymentId?: string;
  appType?: string | undefined;
  namespace?: string | undefined;
  machine?: MachineOfCluster | undefined;
  reach?: Reach | undefined;
  kubeconfig?: string | undefined;
}

export interface MachineOfCluster {
  deviceId: string;
  leaving?: string | undefined;
}

export function destroyAppArgs(
  deployment: Pick<DeploymentMetadata, 'name' | 'clusterId' | 'strategy' | 'deploymentId' | 'appType' | 'namespace'> & { id?: string | undefined },
  cluster: Pick<ClusterMetadata, 'name'> | undefined,
  logFile: string,
  handed: HandOver,
): DestroyAppArgs {
  return {
    name: deployment.name,
    clusterId: deployment.clusterId,
    clusterName: cluster?.name || 'unknown',
    strategy: deployment.strategy || 'helm',
    logFile,
    deploymentId: deployment.deploymentId || 'default',
    ...(deployment.appType ? { appType: deployment.appType } : {}),
    ...(deployment.namespace ? { namespace: deployment.namespace } : {}),
    ...('machine' in handed
      ? { machine: { ...handed.machine, ...(deployment.id ? { leaving: deployment.id } : {}) } }
      : { reach: handed.reach }),
  };
}

export function destroyAppWorkflowId(deployment: Pick<DeploymentMetadata, 'name'>, now: number, nonce: string): string {
  return `app-destroy-${deployment.name}-${now}-${nonce}`;
}
