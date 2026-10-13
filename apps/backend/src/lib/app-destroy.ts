import type { ClusterMetadata, DeploymentMetadata } from './types.js';

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
}

export function destroyAppArgs(
  deployment: Pick<DeploymentMetadata, 'name' | 'clusterId' | 'strategy' | 'deploymentId' | 'appType' | 'namespace'>,
  cluster: Pick<ClusterMetadata, 'name' | 'provider' | 'gpuEnabled' | 'kubeconfigPath'> | undefined,
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
  };
}

export function destroyAppWorkflowId(deployment: Pick<DeploymentMetadata, 'name'>, now: number, nonce: string): string {
  return `app-destroy-${deployment.name}-${now}-${nonce}`;
}
