import type { ClusterMetadata, DeploymentMetadata, LocalAgentDeviceMetadata } from '../../platform/index.js';

export type ReportedClusterState = 'absent' | 'stopped' | 'running';

export const machineClusterId = (deviceId: string): string => `machine-${deviceId}`;

export const reportedClusterState = (raw: unknown): ReportedClusterState | undefined => {
  const state = (raw as { state?: unknown } | undefined)?.state;
  return state === 'absent' || state === 'stopped' || state === 'running' ? state : undefined;
};

export const newMachineCluster = (device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId' | 'name' | 'meshIp'>, at: string): ClusterMetadata => ({
  id: machineClusterId(device.id),
  name: device.name,
  provider: 'machine',
  status: 'stopped',
  machineId: device.id,
  ownerId: device.ownerId,
  createdAt: at,
  ...(device.meshIp ? { meshIp: device.meshIp } : {}),
});

export const appsOn = (deployments: readonly DeploymentMetadata[], clusterId: string, leaving?: string): DeploymentMetadata[] =>
  deployments.filter((deployment) => deployment.clusterId === clusterId && deployment.id !== leaving);
