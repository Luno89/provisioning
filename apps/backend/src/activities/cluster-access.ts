import fs from 'fs/promises';
import path from 'path';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider, isSelfManagedCluster } from '../lib/cluster-topology.js';
import type { ClusterMetadata } from '../lib/types.js';

export interface ClusterRef {
  clusterName: string;
  provider: string;
  gpuEnabled?: boolean | undefined;
  kubeconfigPath?: string | undefined;
}

export function clusterAccess(cluster: ClusterRef): { physicalName: string; kubeconfigPath: string } {
  const isMock = isMockCloudProvider(cluster.provider as ClusterMetadata['provider'], hasCloudCredentials);
  const physicalName = isMock ? `mock-${cluster.provider}-${cluster.clusterName}` : cluster.clusterName;
  const kubeconfigPath = isSelfManagedCluster(cluster.provider as ClusterMetadata['provider'], isMock)
    ? `/tmp/kubeconfig-${physicalName}`
    : path.join(process.cwd(), '.kube/config');
  return { physicalName, kubeconfigPath };
}

export async function reachCluster(infra: InfrastructureService, cluster: ClusterRef): Promise<string> {
  const isMock = isMockCloudProvider(cluster.provider as ClusterMetadata['provider'], hasCloudCredentials);
  if (cluster.gpuEnabled || cluster.provider === 'k3d' || isMock) {
    const physicalName = isMock ? `mock-${cluster.provider}-${cluster.clusterName}` : cluster.clusterName;
    const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;
    const present = await fs.access(kubeconfigPath).then(() => true, () => false);
    if (!present) {
      const content = cluster.gpuEnabled ? await infra.getManagementClusterKubeconfig(physicalName) : await infra.getKubeconfig(physicalName);
      await fs.writeFile(kubeconfigPath, content, 'utf-8');
    }
    return kubeconfigPath;
  }
  if (!cluster.kubeconfigPath) throw new Error(`there is no way to reach the cluster ${cluster.clusterName}: it has no kubeconfig`);
  return cluster.kubeconfigPath;
}
