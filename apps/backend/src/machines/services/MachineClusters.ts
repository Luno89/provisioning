import { encryptValue, type ClusterMetadata, type Database, type LocalAgentDeviceMetadata, type SecretKey } from '../../platform/index.js';
import type { GpuReport, MachineCapacity, MachineClusterResult } from '@koala/engine-core';
import { appsOn, clusterCapacityOf, machineClusterId, newMachineCluster, type ReportedClusterState } from '../lib/machine-clusters.js';

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

  async reported(device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId' | 'name' | 'meshIp'>, state: ReportedClusterState, gpus?: GpuReport, capacity?: MachineCapacity): Promise<ClusterMetadata | undefined> {
    const cluster = await this.clusterOf(device.id);
    if (state === 'absent') {
      if (cluster && !appsOn(await this.deps.store.getDeployments(), cluster.id).length) {
        await this.deps.store.deleteCluster(cluster.id);
      }
      return undefined;
    }
    const reported: Partial<ClusterMetadata> = {
      ...(gpus ? { gpus: gpus.gpus, gpuProblems: gpus.problems } : {}),
      ...(capacity ? { capacity: clusterCapacityOf(capacity, gpus?.gpus ?? cluster?.gpus) } : {}),
    };
    if (cluster) {
      if (!Object.keys(reported).length) return cluster;
      await this.deps.store.patchCluster(cluster.id, reported);
      return { ...cluster, ...reported };
    }
    const made = { ...newMachineCluster(device, (this.deps.now ?? (() => new Date()))().toISOString()), ...reported };
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

  async gpuReports(): Promise<Map<string, Pick<ClusterMetadata, 'gpus' | 'gpuProblems'>>> {
    return new Map((await this.deps.store.getClusters()).filter((cluster) => cluster.gpus || cluster.gpuProblems).map((cluster) => [cluster.id, {
      ...(cluster.gpus ? { gpus: cluster.gpus } : {}),
      ...(cluster.gpuProblems ? { gpuProblems: cluster.gpuProblems } : {}),
    }]));
  }

  async forget(device: Pick<LocalAgentDeviceMetadata, 'id' | 'ownerId'>): Promise<void> {
    const cluster = await this.clusterOf(device.id);
    if (!cluster) return;
    await this.deps.store.deleteDeploymentsOfCluster(cluster.id);
    await this.deps.store.deleteCluster(cluster.id);
  }
}
