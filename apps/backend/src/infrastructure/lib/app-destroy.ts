import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';

export interface DestroyAppArgs {
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  strategy: string;
  logFile: string;
  deploymentId?: string;
  appType?: string | undefined;
  namespace?: string | undefined;
  gpuEnabled?: boolean | undefined;
  kubeconfigPath?: string | undefined;
  machine?: MachineOfCluster | undefined;
  kubeconfig?: string | undefined;
}

export interface MachineOfCluster {
  deviceId: string;
  leaving?: string | undefined;
}

export function destroyAppArgs(
  deployment: Pick<DeploymentMetadata, 'name' | 'clusterId' | 'strategy' | 'deploymentId' | 'appType' | 'namespace'> & { id?: string | undefined },
  cluster: Pick<ClusterMetadata, 'name' | 'provider' | 'gpuEnabled' | 'kubeconfigPath' | 'machineId'> | undefined,
  logFile: string,
): DestroyAppArgs {
  return {
    name: deployment.name,
    clusterId: deployment.clusterId,
    clusterName: cluster?.name || 'unknown',
    provider: cluster?.provider || 'k3d',
    strategy: deployment.strategy || 'helm',
    logFile,
    deploymentId: deployment.deploymentId || 'default',
    ...(deployment.appType ? { appType: deployment.appType } : {}),
    ...(deployment.namespace ? { namespace: deployment.namespace } : {}),
    ...(cluster?.gpuEnabled ? { gpuEnabled: true } : {}),
    ...(cluster?.kubeconfigPath ? { kubeconfigPath: cluster.kubeconfigPath } : {}),
    ...(cluster?.provider === 'machine' && cluster.machineId ? { machine: { deviceId: cluster.machineId, ...(deployment.id ? { leaving: deployment.id } : {}) } } : {}),
  };
}

export function destroyAppWorkflowId(deployment: Pick<DeploymentMetadata, 'name'>, now: number, nonce: string): string {
  return `app-destroy-${deployment.name}-${now}-${nonce}`;
}
