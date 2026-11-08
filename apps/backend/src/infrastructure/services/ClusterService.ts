import { type Actions, allowed, BaseService, type ClusterMetadata, clusterResource, type Database, listAt, numberAt, type Principal, textAt } from '../../platform/index.js';
import type { ClusterAccess } from './ClusterAccess.js';
import { ignore } from '@koala/engine-core/failures';
import { capacityFromNodes, type ClusterCapacity } from '../lib/cluster-capacity.js';
import { parseNvidiaSmiVram } from '../lib/gpu-vram.js';
import { execShell, type Shell } from '../lib/shell.js';

export class ClusterService extends BaseService {
  readonly access: ClusterAccess;

  private readonly shell: Shell;
  private readonly instanceOwnerId: string | undefined;

  constructor(db: Database, access: ClusterAccess, places: { shell?: Shell | undefined; instanceOwnerId?: string | undefined } = {}) {
    super(db);
    this.access = access;
    this.shell = places.shell ?? execShell;
    this.instanceOwnerId = places.instanceOwnerId;
  }

  ownClusterId(): string | undefined {
    return this.access.ownId();
  }

  isKoalasCluster(clusterId: string): boolean {
    return clusterId === this.ownClusterId();
  }

  async ownCluster(): Promise<ClusterMetadata | undefined> {
    const id = this.ownClusterId();
    if (!id) return undefined;
    const record = (await this.db.infrastructure.getClusters()).find((cluster) => cluster.id === id);
    const cluster: ClusterMetadata = { ...(record ?? this.standIn(id)), status: 'healthy', lastSyncedAt: new Date().toISOString() };
    const capacity = await this.readLiveCapacity(() => this.access.kubectl(cluster.id, ['get', 'nodes', '-o', 'json'])).catch(ignore('a cluster whose capacity cannot be read now shows without it'));
    return capacity ? { ...cluster, capacity } : cluster;
  }

  private standIn(id: string): ClusterMetadata {
    const { here } = this.access;
    const owner = this.instanceOwnerId ? { ownerId: this.instanceOwnerId } : {};
    if (here.root) return { id, name: 'root', provider: 'root', status: 'healthy' };
    if (here.koalaMachineId) return { id, name: id, provider: 'machine', machineId: here.koalaMachineId, status: 'healthy', ...owner };
    return { id, name: id, provider: 'pool', status: 'healthy', ...owner };
  }

  async clustersOwnedBy(ownerId: string): Promise<ClusterMetadata[]> {
    const own = await this.ownCluster();
    const records = (await this.db.infrastructure.getClusters()).filter((cluster) => cluster.ownerId === ownerId && cluster.id !== own?.id);
    return [...(own && own.ownerId === ownerId ? [own] : []), ...records];
  }

  private async readLiveCapacity(readNodes: () => Promise<string>): Promise<ClusterCapacity | undefined> {
    let capacity: ClusterCapacity | undefined;
    try {
      const nodesJson = await readNodes();
      capacity = capacityFromNodes(JSON.parse(nodesJson));
    } catch {
      return undefined;
    }
    if (!capacity || capacity.gpuVramMib || !capacity.gpuCount) return capacity;

    try {
      const { stdout } = await this.shell('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
      const mib = parseNvidiaSmiVram(stdout);
      if (mib) capacity = { ...capacity, gpuVramMib: mib };
    } catch (failure) {
      ignore('a host whose nvidia-smi does not answer shows its capacity without VRAM')(failure);
    }
    return capacity;
  }

  async getAll(principal: Principal) {
    const own = await this.ownCluster();
    const records = (await this.db.infrastructure.getClusters()).filter((cluster) => cluster.id !== own?.id);
    return [...(own ? [own] : []), ...records].filter((c) => allowed(principal, 'see', clusterResource(c)));
  }

  async getByIdUnscoped(id: string): Promise<ClusterMetadata | undefined> {
    if (this.isKoalasCluster(id)) return this.ownCluster();
    const clusters = await this.db.infrastructure.getClusters();
    return clusters.find((c) => c.id === id);
  }

  async getById(id: string, principal: Principal, action: Actions['cluster'] = 'see') {
    const cluster = await this.getByIdUnscoped(id);
    return cluster && allowed(principal, action, clusterResource(cluster)) ? cluster : undefined;
  }

  private async listAllPods(clusterId: string): Promise<unknown[]> {
    return listAt(JSON.parse(await this.access.kubectl(clusterId, ['get', 'pods', '--all-namespaces', '-o', 'json'])) as unknown, 'items');
  }

  async getGpuStatus(id: string, principal: Principal) {
    const cluster = await this.getById(id, principal, 'see-everything');
    if (!cluster) throw new Error('Cluster not found');

    const nodes = listAt(JSON.parse(await this.access.kubectl(cluster.id, ['get', 'nodes', '-o', 'json'])) as unknown, 'items');
    const pods = await this.listAllPods(cluster.id);

    const devicePlugins: { vendor: string; name: string; status: string; readyPods: number; desiredPods: number }[] = [];
    const dsOutput = await this.access.kubectl(cluster.id, ['get', 'daemonsets', '-n', 'kube-system', '-o', 'json']);
    const dsItems = listAt(JSON.parse(dsOutput) as unknown, 'items');
    for (const ds of dsItems) {
      const name = textAt(ds, 'metadata', 'name') || '';
      if (name.includes('nvidia-device-plugin') || name.includes('amdgpu-device-plugin')) {
        const vendor = name.includes('nvidia') ? 'NVIDIA' : 'AMD';
        const readyPods = numberAt(ds, 'status', 'numberReady') || 0;
        const desiredPods = numberAt(ds, 'status', 'desiredNumberScheduled') || 0;
        devicePlugins.push({
          vendor,
          name,
          status: readyPods > 0 && readyPods >= desiredPods ? 'active' : 'degraded',
          readyPods,
          desiredPods,
        });
      }
    }

    let totalCapacity = 0;
    let totalAllocatable = 0;
    let vendor = 'none';

    const nodeSummaries = nodes.map((node) => {
      const nodeName = textAt(node, 'metadata', 'name') || 'unknown';
      const capacityOf = (resource: string) => parseInt(textAt(node, 'status', 'capacity', resource) || '0', 10);
      const allocatableOf = (resource: string) => parseInt(textAt(node, 'status', 'allocatable', resource) || '0', 10);

      const nvidiaCap = capacityOf('nvidia.com/gpu');
      const amdCap = capacityOf('amd.com/gpu');

      const nvidiaAlloc = allocatableOf('nvidia.com/gpu');
      const amdAlloc = allocatableOf('amd.com/gpu');

      const nodeCap = nvidiaCap + amdCap;
      const nodeAlloc = nvidiaAlloc + amdAlloc;

      if (nvidiaCap > 0) vendor = 'NVIDIA';
      else if (amdCap > 0 && vendor === 'none') vendor = 'AMD';

      totalCapacity += nodeCap;
      totalAllocatable += nodeAlloc;

      return {
        name: nodeName,
        gpuCapacity: nodeCap,
        gpuAllocatable: nodeAlloc,
        nvidiaGpus: nvidiaCap,
        amdGpus: amdCap,
      };
    });

    let totalAllocated = 0;
    const gpuPods: { name: string; namespace: string; gpus: number; status: string }[] = [];

    for (const pod of pods) {
      const phase = textAt(pod, 'status', 'phase');
      if (phase === 'Succeeded' || phase === 'Failed') continue;

      let podGpuCount = 0;

      for (const container of listAt(pod, 'spec', 'containers')) {
        const limit = (resource: string) => textAt(container, 'resources', 'limits', resource);
        const request = (resource: string) => textAt(container, 'resources', 'requests', resource);
        const gpuReq = parseInt(limit('nvidia.com/gpu') || request('nvidia.com/gpu') || limit('amd.com/gpu') || request('amd.com/gpu') || '0', 10);
        podGpuCount += gpuReq;
      }

      if (podGpuCount > 0) {
        totalAllocated += podGpuCount;
        gpuPods.push({
          name: textAt(pod, 'metadata', 'name') || 'unknown',
          namespace: textAt(pod, 'metadata', 'namespace') || 'default',
          gpus: podGpuCount,
          status: phase || 'Unknown',
        });
      }
    }

    const availableGpus = Math.max(0, totalAllocatable - totalAllocated);

    return {
      hasGpu: totalCapacity > 0,
      vendor,
      totalCapacity,
      totalAllocatable,
      totalAllocated,
      availableGpus,
      nodes: nodeSummaries,
      devicePlugins,
      gpuPods,
    };
  }
}
