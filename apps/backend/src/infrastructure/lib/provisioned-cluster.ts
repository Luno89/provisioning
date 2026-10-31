import type { ClusterMetadata } from '../../platform/lib/types.js';
import type { ClusterCapacity } from './cluster-capacity.js';

export interface ProvisionedCluster {
  status: string;
  msg: string;
  kubeconfig?: string;
  logFile?: string;
  hetznerServerId?: string;
  doServerId?: string;
  meshIp?: string;
  createdHost?: string;
  createdUsername?: string;
  createdPrivateKey?: string;
  capacity?: ClusterCapacity;
}

export function provisionedFrom(result: Omit<ProvisionedCluster, 'kubeconfig'> & { kubeconfigPath?: string }, logFile: string | undefined): ProvisionedCluster {
  const { kubeconfigPath, ...rest } = result;
  return {
    ...rest,
    status: 'healthy',
    msg: result.msg || 'Cluster provisioned',
    ...(kubeconfigPath ? { kubeconfig: kubeconfigPath } : {}),
    ...(logFile ? { logFile } : {}),
  };
}

export function clusterFieldsFrom(provisioned: ProvisionedCluster, seal: (secret: string) => string): Partial<ClusterMetadata> {
  return {
    ...(provisioned.meshIp ? { meshIp: provisioned.meshIp } : {}),
    ...(provisioned.capacity ? { capacity: provisioned.capacity } : {}),
    ...(provisioned.createdHost
      ? {
          remoteHost: provisioned.createdHost,
          ...(provisioned.createdUsername ? { remoteUsername: provisioned.createdUsername } : {}),
          ...(provisioned.createdPrivateKey ? { remoteSshPrivateKeyEnc: seal(provisioned.createdPrivateKey) } : {}),
          ...(provisioned.hetznerServerId ? { hetznerServerId: provisioned.hetznerServerId } : {}),
          ...(provisioned.doServerId ? { doServerId: provisioned.doServerId } : {}),
        }
      : {}),
  };
}
