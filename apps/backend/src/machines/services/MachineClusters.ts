import { encryptValue, type ClusterMetadata, type Database, type LocalAgentDeviceMetadata, type SecretKey } from '../../platform/index.js';
import type { MachineClusterResult } from '@koala/engine-core';
import { appsOn, machineClusterId, newMachineCluster, type ReportedClusterState } from '../lib/machine-clusters.js';

export interface MachineClustersDeps {
  store: Pick<Database['infrastructure'], 'getClusters' | 'saveCluster' | 'patchCluster' | 'deleteCluster' | 'getDeployments' | 'deleteDeploymentsOfCluster'>;
  dataKey: SecretKey;
  koalaMachineId?: string | undefined;
  now?: (() => Date) | undefined;
}

export class MachineClusters {
  constructor(private readonly deps: MachineClustersDeps) {}

  private async clusterOf(deviceId: string): Promise<ClusterMetadata | undefined> {
    const id = machineClusterId(deviceId);
    return (await this.deps.store.getClusters()).find((cluster) => cluster.id === id);
  }

  async reported(device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId' | 'name' | 'meshIp'>, state: ReportedClusterState): Promise<ClusterMetadata | undefined> {
    const cluster = await this.clusterOf(device.id);
    if (state === 'absent') {
      if (cluster && !appsOn(await this.deps.store.getDeployments(), cluster.id).length) {
        await this.deps.store.deleteCluster(cluster.id);
      }
      return undefined;
    }
    if (cluster) return cluster;
    const made = newMachineCluster(device, (this.deps.now ?? (() => new Date()))().toISOString());
    await this.deps.store.saveCluster(made);
    return made;
  }

  async started(clusterId: string, result: MachineClusterResult): Promise<void> {
    const cluster = (await this.deps.store.getClusters()).find((candidate) => candidate.id === clusterId);
    if (!cluster) throw new Error(`${clusterId} is not a machine's cluster this Koala knows`);
    if (result.state !== 'running') throw new Error(`${cluster.name}'s cluster answered ${result.state} when it was started`);
    await this.deps.store.patchCluster(clusterId, {
      status: 'healthy',
      meshIp: result.meshIp,
      kubeconfigEnc: encryptValue(result.kubeconfig, this.deps.dataKey),
      lastSyncedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
  }

  async stopped(clusterId: string): Promise<void> {
    const cluster = (await this.deps.store.getClusters()).find((candidate) => candidate.id === clusterId);
    if (!cluster) return;
    await this.deps.store.patchCluster(clusterId, { status: 'stopped' });
  }

  async idle(clusterId: string, leaving?: string): Promise<boolean> {
    if (this.deps.koalaMachineId && clusterId === machineClusterId(this.deps.koalaMachineId)) return false;
    return appsOn(await this.deps.store.getDeployments(), clusterId, leaving).length === 0;
  }

  async forget(device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId'>): Promise<void> {
    const cluster = await this.clusterOf(device.id);
    if (!cluster) return;
    await this.deps.store.deleteDeploymentsOfCluster(cluster.id);
    await this.deps.store.deleteCluster(cluster.id);
  }
}
