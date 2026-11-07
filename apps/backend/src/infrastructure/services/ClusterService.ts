import { type Actions, allowed, authorize, BaseService, type ClusterMetadata, clusterResource, type Database, listAt, numberAt, type Principal, textAt, writePrivate } from '../../platform/index.js';
import type { ClusterAccess } from './ClusterAccess.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { TemporalBridge } from './TemporalBridge.js';
import { ignore } from '@koala/engine-core/failures';
import { hasCloudCredentials, isMockCloudProvider } from './cloud-credentials.js';
import { capacityFromNodes, type ClusterCapacity } from '../lib/cluster-capacity.js';
import { machineClusterId } from '../lib/cluster-name.js';
import { parseNvidiaSmiVram } from '../lib/gpu-vram.js';
import { execShell, type Shell } from '../lib/shell.js';
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

const SYSTEM_CLUSTER_ID = 'provisioning-lunorica';

export class ClusterService extends BaseService {
  private infra: InfrastructureService;
  readonly access: ClusterAccess;
  private temporalBridge?: Pick<TemporalBridge, 'terminateWorkflow'>;

  private readonly kubeconfigDir: string;
  private readonly shell: Shell;
  private readonly koalaMachineId: string | undefined;

  constructor(db: Database, infra: InfrastructureService, access: ClusterAccess, places: { kubeconfigDir?: string | undefined; shell?: Shell | undefined; koalaMachineId?: string | undefined } = {}) {
    super(db);
    this.infra = infra;
    this.access = access;
    this.kubeconfigDir = places.kubeconfigDir ?? '/tmp';
    this.shell = places.shell ?? execShell;
    this.koalaMachineId = 'koalaMachineId' in places ? places.koalaMachineId : process.env.INSTANCE_MACHINE_ID || undefined;
  }

  private koalaClusterId(): string | undefined {
    return this.koalaMachineId ? machineClusterId(this.koalaMachineId) : undefined;
  }

  isKoalasCluster(clusterId: string): boolean {
    return clusterId === SYSTEM_CLUSTER_ID || clusterId === this.koalaClusterId();
  }

  private async koalasMachineCluster(machineId: string): Promise<ClusterMetadata> {
    const id = machineClusterId(machineId);
    const record = (await this.db.infrastructure.getClusters()).find((cluster) => cluster.id === id);
    const cluster: ClusterMetadata = { ...(record ?? { id, name: id, provider: 'machine', machineId }), status: 'healthy', isSystem: true, lastSyncedAt: new Date().toISOString() };
    const capacity = await this.readLiveCapacity(() => this.access.kubectl(cluster.id, ['get', 'nodes', '-o', 'json'])).catch(ignore('a cluster whose capacity cannot be read now shows without it'));
    return capacity ? { ...cluster, capacity } : cluster;
  }

  setTemporalBridge(temporalBridge: Pick<TemporalBridge, 'terminateWorkflow'>) {
    this.temporalBridge = temporalBridge;
  }

  hasCloudCredentials(provider: string): boolean {
    return hasCloudCredentials(provider);
  }

  isMockCloud(cluster: ClusterMetadata): boolean {
    return isMockCloudProvider(cluster.provider, (p) => this.hasCloudCredentials(p));
  }

  getPhysicalClusterName(cluster: ClusterMetadata): string {
    return this.isMockCloud(cluster) ? `mock-${cluster.provider}-${cluster.name}` : cluster.name;
  }

  private async getRealNameservers(): Promise<string[]> {
    const paths = [
      '/run/systemd/resolve/resolv.conf',
      '/var/run/systemd/resolve/resolv.conf',
      '/etc/resolv.conf'
    ];
    
    const nameservers: string[] = [];
    for (const p of paths) {
      try {
        const content = await fs.readFile(p, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('nameserver ')) {
            const ip = trimmed.substring(11).trim();
            if (ip && !ip.startsWith('127.') && ip !== '::1') {
              nameservers.push(ip);
            }
          }
        }
        if (nameservers.length > 0) {
          return nameservers;
        }
      } catch (failure) {
        ignore('a resolver file this host does not have is passed over for the next')(failure);
      }
    }
    
    return ['8.8.8.8', '1.1.1.1'];
  }

  async getKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    if (cluster.provider === 'machine') return this.machineKubeconfig(cluster);
    const isMock = this.isMockCloud(cluster);
    if (cluster.gpuEnabled || cluster.provider === 'k3d' || isMock) {
      const physicalName = this.getPhysicalClusterName(cluster);
      const dynamicPath = `${this.kubeconfigDir}/kubeconfig-${physicalName}`;
      let exists = false;
      try {
        await fs.access(dynamicPath);
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        try {
          const content = cluster.gpuEnabled
            ? await this.infra.getManagementClusterKubeconfig(physicalName)
            : await this.infra.getKubeconfig(physicalName);
          await writePrivate(dynamicPath, content);
        } catch (err) {
          this.logger.error(`Failed to dynamically fetch kubeconfig for cluster ${physicalName}: ${(err as Error).message}`);
          return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
        }
      }
      return dynamicPath;
    }
    return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
  }

  private async machineKubeconfig(cluster: ClusterMetadata): Promise<string> {
    return this.access.kubeconfigOf(cluster.id);
  }

  private writtenKubeconfig(cluster: ClusterMetadata): string {
    return `${this.kubeconfigDir}/kubeconfig-${this.getPhysicalClusterName(cluster)}`;
  }

  private async getOwnKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    const resolved = await this.getKubeconfigPath(cluster);
    const selfManaged = cluster.provider === 'hetzner' || cluster.provider === 'do';
    if (selfManaged && (!cluster.kubeconfigPath || resolved === DEFAULT_KUBECONFIG)) {
      throw new Error(
        `Cluster "${cluster.name}" has no kubeconfig of its own — refusing to fall back to the management cluster, which would report the wrong cluster's resources.`,
      );
    }
    if (selfManaged) {
      try {
        await fs.access(resolved);
      } catch {
        throw new Error(`Kubeconfig for cluster "${cluster.name}" is missing at ${resolved}.`);
      }
    }
    return resolved;
  }

  async getSystemClusterEntry(): Promise<ClusterMetadata> {
    if (this.koalaMachineId) return this.koalasMachineCluster(this.koalaMachineId);
    let status: ClusterMetadata['status'] = 'failed';
    let capacity: ClusterCapacity | undefined;
    try {
      const content = await this.infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER_ID);
      status = 'healthy';
      const kubeconfigPath = `${this.kubeconfigDir}/kubeconfig-${SYSTEM_CLUSTER_ID}`;
      await writePrivate(kubeconfigPath, content).catch((err: unknown) => {
        this.logger.warn(`Could not write the system cluster's kubeconfig to ${kubeconfigPath}, so its capacity is read from what is there: ${(err as Error).message}`);
      });
      capacity = await this.readLiveCapacity(() => this.infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath));
    } catch {
      status = 'failed';
    }
    return {
      id: SYSTEM_CLUSTER_ID,
      name: SYSTEM_CLUSTER_ID,
      provider: 'k3d',
      status,
      gpuEnabled: true,
      isSystem: true,
      ...(capacity ? { capacity } : {}),
      lastSyncedAt: new Date().toISOString(),
    };
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

  async ensureSystemClusterGpuReady(): Promise<void> {
    try {
      const kubeconfigPath = `${this.kubeconfigDir}/kubeconfig-${SYSTEM_CLUSTER_ID}`;
      const content = await this.infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER_ID);
      await writePrivate(kubeconfigPath, content);
      await this.infra.checkGpuToolkit('nvidia');
      await this.infra.installGpuDevicePlugin('nvidia', kubeconfigPath);
      this.logger.info('GPU device plugin ready on the management cluster.');
    } catch (err) {
      this.logger.info(`Skipping management-cluster GPU device plugin install: ${(err as Error).message}`);
    }
  }

  async reconcileAllClusters(io?: SocketServer): Promise<ClusterMetadata[]> {
    const dbClusters = await this.db.infrastructure.getClusters();
    const activeK3dNames = await this.infra.listLocalClusters();

    const cleanClusters: ClusterMetadata[] = [];

    for (const cluster of dbClusters) {
      const isMock = this.isMockCloud(cluster);
      if (cluster.gpuEnabled || !(cluster.provider === 'k3d' || isMock)) {
        cleanClusters.push(cluster);
        continue;
      }
      const physicalName = this.getPhysicalClusterName(cluster);
      if (cluster.status === 'provisioning') {
        const recovered = await this.recoverStuckCluster(cluster, physicalName, activeK3dNames);
        if (recovered) {
          await this.db.infrastructure.patchCluster(cluster.id, { status: recovered.status, ...(recovered.lastSyncedAt ? { lastSyncedAt: recovered.lastSyncedAt } : {}) });
          cleanClusters.push(recovered);
          if (io) io.emit('cluster-updated');
        } else {
          cleanClusters.push(cluster);
        }
        continue;
      }
      if (cluster.status === 'destroying') continue;
      if (activeK3dNames.includes(physicalName)) {
        cleanClusters.push(cluster);
        continue;
      }
      this.logger.info(`Detected local cluster ${physicalName} deleted outside the system. Syncing...`);
      if (io) {
        io.to(`user:${cluster.ownerId}`).emit('resource-destroyed', { id: cluster.id, type: 'cluster', name: cluster.name, outOfBand: true });
      }
      await this.db.infrastructure.deleteDeploymentsOfCluster(cluster.id);
      await this.db.infrastructure.deleteCluster(cluster.id);
      await fs.rm(`${this.kubeconfigDir}/kubeconfig-${physicalName}`, { force: true }).catch((err: unknown) => {
        this.logger.warn(`Could not remove the kubeconfig of ${physicalName}, deleted outside the system: ${(err as Error).message}`);
      });
    }

    const systemCluster = await this.getSystemClusterEntry();
    return [systemCluster, ...cleanClusters.filter((cluster) => cluster.id !== systemCluster.id)];
  }

  async getAll(principal: Principal, io?: SocketServer) {
    const all = await this.reconcileAllClusters(io);
    return all.filter((c) => allowed(principal, 'see', clusterResource(c)));
  }

  private async recoverStuckCluster(
    cluster: ClusterMetadata,
    physicalName: string,
    activeK3dNames: string[],
  ): Promise<ClusterMetadata | null> {
    const stuckThreshold = 15 * 60 * 1000;
    const clusterAge = Date.now() - new Date(cluster.createdAt || cluster.lastSyncedAt || Date.now()).getTime();
    if (clusterAge < stuckThreshold) return null;

    this.logger.info(`Cluster ${cluster.name} stuck in provisioning for ${Math.round(clusterAge / 60000)}min — recovering...`);

    if (!activeK3dNames.includes(physicalName)) {
      this.logger.info(`Cluster ${cluster.name} k3d cluster no longer exists — marking as failed`);
      return { ...cluster, status: 'failed', lastSyncedAt: new Date().toISOString() };
    }

    try {
      const kubeconfigPath = `${this.kubeconfigDir}/kubeconfig-${physicalName}`;
      const helmOutput = await this.infra.runHelm(['list', '-A', '-o', 'json'], kubeconfigPath);
      const releaseNames = listAt(JSON.parse(helmOutput) as unknown).map((release) => textAt(release, 'name'));
      const hasMonitoring = releaseNames.includes('kube-prometheus-stack');
      const hasTraefik = releaseNames.includes('traefik');

      if (hasMonitoring && hasTraefik) {
        this.logger.info(`Cluster ${cluster.name} has expected helm releases — marking as healthy`);
        return { ...cluster, status: 'healthy', lastSyncedAt: new Date().toISOString() };
      }

      this.logger.info(`Cluster ${cluster.name} missing expected helm releases — marking as failed`);
      return { ...cluster, status: 'failed', lastSyncedAt: new Date().toISOString() };
    } catch (err) {
      this.logger.warn(`Failed to verify helm releases for stuck cluster ${cluster.name}: ${(err as Error).message}`);
      return null;
    }
  }

  async getByIdUnscoped(id: string): Promise<ClusterMetadata | undefined> {
    if (this.isKoalasCluster(id)) {
      return this.getSystemClusterEntry();
    }
    const clusters = await this.db.infrastructure.getClusters();
    return clusters.find((c) => c.id === id);
  }

  async getById(id: string, principal: Principal, action: Actions['cluster'] = 'see') {
    const cluster = await this.getByIdUnscoped(id);
    return cluster && allowed(principal, action, clusterResource(cluster)) ? cluster : undefined;
  }

  private async deletable(id: string, principal: Principal): Promise<ClusterMetadata> {
    const cluster = await this.getByIdUnscoped(id);
    if (!cluster) throw new Error('Cluster not found');
    const decision = authorize(principal, 'delete', clusterResource(cluster));
    if (!decision.allowed) throw new Error(decision.error);
    return cluster;
  }

  async abort(id: string, principal: Principal, io?: SocketServer) {
    const cluster = await this.deletable(id, principal);

    const logFile = this.infra.getLogPath(`${cluster.name}-abort`);
    await this.db.infrastructure.saveCluster({ ...cluster, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        if (cluster.temporalWorkflowId && this.temporalBridge) {
          await this.temporalBridge.terminateWorkflow(cluster.temporalWorkflowId, 'User aborted cluster provisioning');
        }

        const isMock = this.isMockCloud(cluster);
        const physicalName = this.getPhysicalClusterName(cluster);

        if (cluster.gpuEnabled) {
          await fs.rm(this.writtenKubeconfig(cluster), { force: true }).catch((err: unknown) => {
            this.logger.warn(`Could not remove the kubeconfig at ${this.writtenKubeconfig(cluster)} during abort: ${(err as Error).message}`);
          });
        } else if (cluster.provider === 'k3d' || isMock) {
          try {
            await this.infra.deleteLocalCluster(physicalName, { logFile, io, resourceId: id });
            await this.infra.disconnectNginxFromNetwork(physicalName);
            await fs.rm(this.writtenKubeconfig(cluster), { force: true });
          } catch (err) {
            this.logger.warn(`Error deleting physical cluster during abort: ${(err as Error).message}`);
          }
        }

        await this.db.infrastructure.deleteCluster(id);

        if (io) {
          io.to(id).emit('log', '\n--- CLUSTER PROVISIONING ABORTED AND CLEANED UP ---\n');
          io.to(`user:${cluster.ownerId}`).emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
          io.emit('cluster:updated');
        }
      } catch (err) {
        this.logger.error(`Abort failed for cluster ${cluster.name}: ${(err as Error).message}`);
        await this.db.infrastructure.deleteCluster(id);
        if (io) io.emit('cluster:updated');
      }
    })().catch((err: unknown) => this.logger.error(`Unhandled error during cluster abort: ${(err as Error).message}`));
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
    const passthroughEnabled = cluster.gpuEnabled ?? false;

    return {
      passthroughEnabled,
      hasGpu: totalCapacity > 0 || passthroughEnabled,
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
