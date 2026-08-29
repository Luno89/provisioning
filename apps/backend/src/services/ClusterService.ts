import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { Database } from '../lib/db-interface.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { v4 as uuidv4 } from 'uuid';
import { encryptValue } from '../lib/crypto.js';
import { capacityFromNodes, type ClusterCapacity } from '../lib/cluster-capacity.js';
import { parseNvidiaSmiVram } from '../lib/gpu-vram.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

const SYSTEM_CLUSTER_ID = 'provisioning-lunorica';

export class ClusterService extends BaseService {
  private infra: InfrastructureService;
  private masterKey: string;
  private temporalBridge?: any;

  constructor(db: Database, infra: InfrastructureService, masterKey?: string) {
    super(db);
    this.infra = infra;
    this.masterKey = masterKey || '';
  }

  setTemporalBridge(temporalBridge: any) {
    this.temporalBridge = temporalBridge;
  }

  hasCloudCredentials(provider: string): boolean {
    return hasCloudCredentials(provider);
  }

  isMockCloud(cluster: ClusterMetadata): boolean {
    return isMockCloudProvider(cluster.provider, (p) => this.hasCloudCredentials(p));
  }

  async createAwaitingKey(args: {
    name: string;
    ownerId: string;
    host: string;
    username: string;
    privateKey: string;
    port?: number;
  }): Promise<ClusterMetadata> {
    return this.db.saveClusterInfo({
      id: uuidv4(),
      name: args.name,
      provider: 'remote',
      status: 'awaiting-key',
      createdAt: new Date().toISOString(),
      ownerId: args.ownerId,
      remoteHost: args.host,
      remoteUsername: args.username,
      remoteSshPrivateKeyEnc: encryptValue(args.privateKey, this.masterKey),
      ...(args.port !== undefined ? { remoteSshPort: args.port } : {}),
    } as ClusterMetadata);
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
      } catch {
      }
    }
    
    return ['8.8.8.8', '1.1.1.1'];
  }

  async getKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    const isMock = this.isMockCloud(cluster);
    if (cluster.gpuEnabled || cluster.provider === 'k3d' || isMock) {
      const physicalName = this.getPhysicalClusterName(cluster);
      const dynamicPath = `/tmp/kubeconfig-${physicalName}`;
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
          await fs.writeFile(dynamicPath, content, 'utf-8');
        } catch (err: any) {
          this.logger.error(`Failed to dynamically fetch kubeconfig for cluster ${physicalName}: ${err.message}`);
          return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
        }
      }
      return dynamicPath;
    }
    return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
  }

  private async getOwnKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    const resolved = await this.getKubeconfigPath(cluster);
    const selfManaged = cluster.provider === 'hetzner' || cluster.provider === 'remote';
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
    let status: ClusterMetadata['status'] = 'failed';
    let capacity: ClusterCapacity | undefined;
    try {
      const content = await this.infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER_ID);
      status = 'healthy';
      const kubeconfigPath = `/tmp/kubeconfig-${SYSTEM_CLUSTER_ID}`;
      await fs.writeFile(kubeconfigPath, content, 'utf-8').catch(() => {});
      capacity = await this.readLiveCapacity(kubeconfigPath);
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

  private async readLiveCapacity(kubeconfigPath: string): Promise<ClusterCapacity | undefined> {
    let capacity: ClusterCapacity | undefined;
    try {
      const nodesJson = await this.infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
      capacity = capacityFromNodes(JSON.parse(nodesJson));
    } catch {
      return undefined;
    }
    if (!capacity || capacity.gpuVramMib || !capacity.gpuCount) return capacity;

    try {
      const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits');
      const mib = parseNvidiaSmiVram(stdout);
      if (mib) capacity = { ...capacity, gpuVramMib: mib };
    } catch {
    }
    return capacity;
  }

  async ensureSystemClusterGpuReady(): Promise<void> {
    try {
      const kubeconfigPath = `/tmp/kubeconfig-${SYSTEM_CLUSTER_ID}`;
      const content = await this.infra.getManagementClusterKubeconfig(SYSTEM_CLUSTER_ID);
      await fs.writeFile(kubeconfigPath, content, 'utf-8');
      await this.infra.checkGpuToolkit('nvidia');
      await this.infra.installGpuDevicePlugin('nvidia', kubeconfigPath);
      this.logger.info('GPU device plugin ready on the management cluster.');
    } catch (err: any) {
      this.logger.info(`Skipping management-cluster GPU device plugin install: ${err.message}`);
    }
  }

  async reconcileAllClusters(io?: SocketServer): Promise<ClusterMetadata[]> {
    const dbClusters = await this.db.getClusters();
    const activeK3dNames = await this.infra.listLocalClusters();
    const now = new Date().toISOString();

    let changed = false;
    const cleanClusters: ClusterMetadata[] = [];

    for (const cluster of dbClusters) {
      const isMock = this.isMockCloud(cluster);
      if (cluster.gpuEnabled) {
        cleanClusters.push({ ...cluster, lastSyncedAt: now });
        continue;
      }
      if (cluster.provider === 'k3d' || isMock) {
        const physicalName = this.getPhysicalClusterName(cluster);
        if (cluster.status === 'provisioning') {
          const recoveryResult = await this.recoverStuckCluster(cluster, physicalName, activeK3dNames);
          if (recoveryResult) {
            changed = true;
            cleanClusters.push(recoveryResult);
            if (io) io.emit('cluster-updated');
          } else {
            cleanClusters.push({ ...cluster, lastSyncedAt: now });
          }
          continue;
        }
        if (cluster.status === 'destroying') {
          continue;
        }

        if (activeK3dNames.includes(physicalName)) {
          cleanClusters.push({ ...cluster, lastSyncedAt: now });
        } else {
          changed = true;
          this.logger.info(`Detected local cluster ${physicalName} deleted outside the system. Syncing...`);
          if (io) {
            io.emit('resource-destroyed', { id: cluster.id, type: 'cluster', name: cluster.name, outOfBand: true });
          }

          try {
            const deployments = await this.db.getDeployments();
            const cleanDeployments = deployments.filter(d => d.clusterId !== cluster.id);
            if (deployments.length !== cleanDeployments.length) {
              await this.db.saveDeploymentList(cleanDeployments);
            }
            await fs.rm(`/tmp/kubeconfig-${physicalName}`, { force: true }).catch(() => {});
          } catch (err: any) {
            this.logger.error(`Failed to clean up deployments for deleted cluster ${cluster.name}: ${err.message}`);
          }
        }
      } else {
        cleanClusters.push({ ...cluster, lastSyncedAt: now });
      }
    }

    if (changed) {
      await this.db.saveClusterList(cleanClusters);
    }

    const systemCluster = await this.getSystemClusterEntry();
    return [systemCluster, ...cleanClusters];
  }

  async getAll(userId: string, io?: SocketServer) {
    const all = await this.reconcileAllClusters(io);
    return all.filter((c) => c.ownerId === userId || c.isSystem);
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
      const kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;
      const helmOutput = await this.infra.runHelm(['list', '-A', '-o', 'json'], kubeconfigPath);
      const releases = JSON.parse(helmOutput);
      const releaseNames = releases.map((r: any) => r.name);
      const hasMonitoring = releaseNames.includes('kube-prometheus-stack');
      const hasTraefik = releaseNames.includes('traefik');

      if (hasMonitoring && hasTraefik) {
        this.logger.info(`Cluster ${cluster.name} has expected helm releases — marking as healthy`);
        return { ...cluster, status: 'healthy', lastSyncedAt: new Date().toISOString() };
      }

      this.logger.info(`Cluster ${cluster.name} missing expected helm releases — marking as failed`);
      return { ...cluster, status: 'failed', lastSyncedAt: new Date().toISOString() };
    } catch (err: any) {
      this.logger.warn(`Failed to verify helm releases for stuck cluster ${cluster.name}: ${err.message}`);
      return null;
    }
  }

  async discoverClusters(userId: string): Promise<ClusterMetadata[]> {
    const k3dNames = await this.infra.listLocalClusters();
    const dbClusters = await this.db.getClusters();
    const now = new Date().toISOString();
    const discovered: ClusterMetadata[] = [];

    for (const k3dName of k3dNames) {
      const existing = dbClusters.find(
        c => c.name === k3dName || this.getPhysicalClusterName(c) === k3dName
      );
      if (existing) continue;

      const kubeconfigPath = `/tmp/kubeconfig-${k3dName}`;
      let kubeconfigContent: string;
      try {
        kubeconfigContent = await this.infra.getKubeconfig(k3dName);
        await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');
      } catch (err: any) {
        this.logger.warn(`Cannot fetch kubeconfig for discovered cluster ${k3dName}: ${err.message}`);
        continue;
      }

      let status: 'healthy' | 'failed' = 'failed';
      try {
        await this.infra.runKubectl(['get', 'nodes'], kubeconfigPath);
        status = 'healthy';
      } catch (err: any) {
        this.logger.warn(`K8s API ping failed for discovered cluster ${k3dName}: ${err.message}`);
      }

      const metadata: ClusterMetadata = {
        id: uuidv4(),
        name: k3dName,
        provider: 'k3d',
        status,
        kubeconfigPath,
        lastSyncedAt: now,
        ownerId: userId,
      };
      discovered.push(metadata);
    }

    if (discovered.length > 0) {
      const allClusters = [...dbClusters, ...discovered];
      await this.db.saveClusterList(allClusters);
    }

    return discovered;
  }

  async getByIdUnscoped(id: string): Promise<ClusterMetadata | undefined> {
    if (id === SYSTEM_CLUSTER_ID) {
      return this.getSystemClusterEntry();
    }
    const clusters = await this.db.getClusters();
    return clusters.find((c: any) => c.id === id);
  }

  async getById(id: string, userId: string) {
    const cluster = await this.getByIdUnscoped(id);
    if (cluster && !cluster.isSystem && cluster.ownerId !== userId) return undefined;
    return cluster;
  }

  async provision(name: string, provider: ClusterMetadata['provider'], userId: string, io?: SocketServer) {
    const id = uuidv4();
    const logFile = this.infra.getLogPath(name);
    const metadata: ClusterMetadata = { id, name, provider, status: 'provisioning', lastLogPath: logFile, ownerId: userId };
    await this.db.saveCluster(metadata);

    (async () => {
      try {
        let kubeconfigPath = DEFAULT_KUBECONFIG;
        const isMock = this.isMockCloud(metadata);
        const physicalName = this.getPhysicalClusterName(metadata);

        if (provider === 'k3d' || isMock) {
          if (isMock && io) {
            io.to(id).emit('log', `\n--- RUNNING IN MOCK CLOUD MODE (${provider.toUpperCase()}) ---\n`);
            io.to(id).emit('log', `No credentials found for ${provider.toUpperCase()}. Falling back to local k3d cluster "${physicalName}".\n\n`);
          }

          try {
            await this.infra.runKubectl(['config', 'unset', 'clusters.k3d-' + physicalName]);
          } catch {
          }

          await this.infra.createLocalCluster(physicalName, { logFile, io, resourceId: id });

          const kubeconfigContent = await this.infra.getKubeconfig(physicalName);
          kubeconfigPath = `/tmp/kubeconfig-${physicalName}`;
          await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');

          let ready = false;
          for (let i = 0; i < 45; i++) {
            try {
              const nodesJson = await this.infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
              const nodesObj = JSON.parse(nodesJson);
              const nodes = nodesObj.items || [];
              const hasReadyNode = nodes.some((node: any) =>
                node.status?.conditions?.some((c: any) => c.type === 'Ready' && c.status === 'True')
              );
              if (hasReadyNode) {
                ready = true;
                break;
              }
            } catch (err: any) {
              this.logger.info(`Waiting for cluster ${physicalName} API server: ${err.message}`);
            }

            if (i > 0 && i % 5 === 0) {
              try {
                const containerName = `k3d-${physicalName}-server-0`;
                const { exec } = await import('child_process');
                const { promisify } = await import('util');
                const execAsync = promisify(exec);
                const { stdout, stderr } = await execAsync(`docker logs --tail 200 ${containerName}`);
                const logs = stdout + '\n' + stderr;
                if (logs.includes('too many open files') || logs.includes('fsnotify')) {
                  throw new Error(`Docker/Colima VM resource limit exhausted: 'too many open files' in K3s file watcher. Please run 'colima restart' in your terminal to reset the VM limits.`);
                }
              } catch (logErr: any) {
                if (logErr.message.includes('VM resource limit')) {
                  throw logErr;
                }
              }
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          if (!ready) {
            throw new Error(`Cluster ${physicalName} did not get a Ready control plane node in time.`);
          }

          try {
            this.logger.info(`Enabling volume expansion on local-path storage class...`);
            let scPatched = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              try {
                await this.infra.runKubectl(['patch', 'storageclass', 'local-path', '-p', '\'{"allowVolumeExpansion": true}\''], kubeconfigPath);
                this.logger.info(`Successfully enabled volume expansion on local-path storage class`);
                scPatched = true;
                break;
              } catch (err: any) {
                this.logger.info(`Waiting for local-path storage class to be available: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            if (!scPatched) {
              this.logger.error(`local-path StorageClass was not available or could not be patched.`);
            }
          } catch (err: any) {
            this.logger.error(`Failed to patch local-path storage class: ${err.message}`);
          }

          try {
            const dnsList = await this.getRealNameservers();
            this.logger.info(`Patching coredns ConfigMap with nameservers: ${dnsList.join(', ')}`);
            
            let patched = false;
            for (let attempt = 0; attempt < 30; attempt++) {
              try {
                const configMapJson = await this.infra.runKubectl(
                  ['get', 'configmap', 'coredns', '-n', 'kube-system', '-o', 'json'],
                  kubeconfigPath
                );
                const cm = JSON.parse(configMapJson);
                if (cm?.data?.Corefile) {
                  const originalCorefile = cm.data.Corefile;
                  const updatedCorefile = originalCorefile.replace(
                    /forward\s+\.\s+\/etc\/resolv\.conf/g,
                    `forward . ${dnsList.join(' ')}`
                  );
                  if (updatedCorefile !== originalCorefile) {
                    cm.data.Corefile = updatedCorefile;
                    const execAsync = (await import('util')).promisify((await import('child_process')).exec);
                    const containerName = `k3d-${physicalName}-server-0`;
                    const cmJsonString = JSON.stringify(cm).replace(/'/g, "'\\''");
                    await execAsync(`echo '${cmJsonString}' | docker exec -i ${containerName} kubectl replace -f -`);
                    this.logger.info(`Successfully patched coredns ConfigMap`);
                    await this.infra.runKubectl(
                      ['rollout', 'restart', 'deployment/coredns', '-n', 'kube-system'],
                      kubeconfigPath
                    );
                  }
                  patched = true;
                  break;
                }
              } catch (err: any) {
                this.logger.info(`Waiting for coredns configmap to be available: ${err.message}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            if (!patched) {
              this.logger.error(`CoreDNS ConfigMap was not available or could not be patched.`);
            }
          } catch (dnsErr: any) {
            this.logger.error(`Failed to patch coredns: ${dnsErr.message}`);
          }

          await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
          kubeconfigPath = `/tmp/kubeconfig-${name}`;
        }

        const env: Record<string, string> = { 
          STACK_TYPE: 'cluster', 
          ENV: isMock ? 'local' : provider, 
          CLUSTER_NAME: physicalName,
          KUBECONFIG_PATH: kubeconfigPath
        };

        await this.infra.deploy(physicalName, { logFile, io, resourceId: id, env });

        await this.db.saveCluster({ ...metadata, status: 'healthy', kubeconfigPath });
      } catch (err: any) {
        this.logger.error(`Provisioning failed: ${err.message}`);
        await this.db.saveCluster({ ...metadata, status: 'failed' });
      }
    })().catch((err: any) => this.logger.error(`Unhandled error during cluster provisioning: ${err.message}`));

    return metadata;
  }

  async delete(id: string, userId: string, io?: SocketServer) {
    if (id === SYSTEM_CLUSTER_ID) throw new Error('The system management cluster cannot be destroyed');
    const cluster = await this.getById(id, userId);
    if (!cluster) throw new Error('Cluster not found');

    const logFile = this.infra.getLogPath(`${cluster.name}-destroy`);
    await this.db.saveCluster({ ...cluster, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        const isMock = this.isMockCloud(cluster);
        const physicalName = this.getPhysicalClusterName(cluster);
        const kubeconfigPath = await this.getKubeconfigPath(cluster);

        if (cluster.gpuEnabled) {
          try {
            await fs.rm(kubeconfigPath, { force: true });
          } catch {
          }
          const clusters = await this.db.getClusters();
          await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));
          if (io) io.emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
          return;
        }

        await this.infra.destroy(physicalName, {
          logFile, io, resourceId: id,
          env: {
            STACK_TYPE: 'cluster',
            ENV: isMock ? 'local' : cluster.provider,
            CLUSTER_NAME: physicalName,
            KUBECONFIG_PATH: kubeconfigPath
          }
        });

        if (cluster.provider === 'k3d' || isMock) {
            await this.infra.deleteLocalCluster(physicalName, { logFile, io, resourceId: id });
            await this.infra.disconnectNginxFromNetwork(physicalName);
            try {
                await fs.rm(kubeconfigPath, { force: true });
            } catch {
            }
        }

        const clusters = await this.db.getClusters();
        await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));
        if (io) io.emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
      } catch (err: any) {
        this.logger.error(`Destruction failed: ${err.message}`);
        await this.db.saveCluster({ ...cluster, status: 'failed' });
      }
    })().catch((err: any) => this.logger.error(`Unhandled error during cluster destruction: ${err.message}`));
  }

  async abort(id: string, userId: string, io?: SocketServer) {
    if (id === SYSTEM_CLUSTER_ID) throw new Error('The system management cluster cannot be aborted');
    const cluster = await this.getById(id, userId);
    if (!cluster) throw new Error('Cluster not found');

    const logFile = this.infra.getLogPath(`${cluster.name}-abort`);
    await this.db.saveCluster({ ...cluster, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        if (cluster.temporalWorkflowId && this.temporalBridge) {
          await this.temporalBridge.terminateWorkflow(cluster.temporalWorkflowId, 'User aborted cluster provisioning');
        }

        const isMock = this.isMockCloud(cluster);
        const physicalName = this.getPhysicalClusterName(cluster);
        const kubeconfigPath = await this.getKubeconfigPath(cluster);

        if (cluster.gpuEnabled) {
          try {
            await fs.rm(kubeconfigPath, { force: true });
          } catch {}
        } else if (cluster.provider === 'k3d' || isMock) {
          try {
            await this.infra.deleteLocalCluster(physicalName, { logFile, io, resourceId: id });
            await this.infra.disconnectNginxFromNetwork(physicalName);
            await fs.rm(kubeconfigPath, { force: true });
          } catch (err: any) {
            this.logger.warn(`Error deleting physical cluster during abort: ${err.message}`);
          }
        }

        const clusters = await this.db.getClusters();
        await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));

        if (io) {
          io.to(id).emit('log', '\n--- CLUSTER PROVISIONING ABORTED AND CLEANED UP ---\n');
          io.emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
          io.emit('cluster:updated');
        }
      } catch (err: any) {
        this.logger.error(`Abort failed for cluster ${cluster.name}: ${err.message}`);
        const clusters = await this.db.getClusters();
        await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));
        if (io) io.emit('cluster:updated');
      }
    })().catch((err: any) => this.logger.error(`Unhandled error during cluster abort: ${err.message}`));
  }

  async listAllPods(id: string, userId: string) {
    try {
        const cluster = await this.getById(id, userId);
        if (!cluster) throw new Error('Cluster not found');
        const physicalName = this.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || this.isMockCloud(cluster)) ? `k3d-${physicalName}` : undefined;
        const args = ['get', 'pods', '--all-namespaces', '-o', 'json'];
        if (context) args.push('--context', context);
        
        const kubeconfigPath = await this.getOwnKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(args, kubeconfigPath);
        return JSON.parse(output).items;
    } catch (err: any) {
        this.logger.error(`Failed to list all pods: ${err.message}`);
        return [];
    }
  }

  async listReleases(id: string, userId: string) {
    try {
        const cluster = await this.getById(id, userId);
        if (!cluster) throw new Error('Cluster not found');
        const physicalName = this.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || this.isMockCloud(cluster)) ? `k3d-${physicalName}` : undefined;
        const args = ['list', '-A', '-o', 'json'];
        if (context) args.push('--kube-context', context);
        
        const kubeconfigPath = await this.getOwnKubeconfigPath(cluster);
        const output = await this.infra.runHelm(args, kubeconfigPath);
        return JSON.parse(output);
    } catch (err: any) {
        this.logger.error(`Failed to list helm releases: ${err.message}`);
        return [];
    }
  }

  async getGpuStatus(id: string, userId: string) {
    try {
      const cluster = await this.getById(id, userId);
      if (!cluster) throw new Error('Cluster not found');

      const kubeconfigPath = await this.getOwnKubeconfigPath(cluster);
      
      let nodes: any[] = [];
      try {
        const nodesOutput = await this.infra.runKubectl(['get', 'nodes', '-o', 'json'], kubeconfigPath);
        nodes = JSON.parse(nodesOutput).items || [];
      } catch (err: any) {
        this.logger.warn(`Failed to fetch nodes for GPU status on cluster ${id}: ${err.message}`);
      }

      let pods: any[] = [];
      try {
        pods = await this.listAllPods(id, userId);
      } catch (err: any) {
        this.logger.warn(`Failed to fetch pods for GPU status on cluster ${id}: ${err.message}`);
      }

      const devicePlugins: { vendor: string; name: string; status: string; readyPods: number; desiredPods: number }[] = [];
      try {
        const dsOutput = await this.infra.runKubectl(['get', 'daemonsets', '-n', 'kube-system', '-o', 'json'], kubeconfigPath);
        const dsItems = JSON.parse(dsOutput).items || [];
        for (const ds of dsItems) {
          const name = ds.metadata?.name || '';
          if (name.includes('nvidia-device-plugin') || name.includes('amdgpu-device-plugin')) {
            const vendor = name.includes('nvidia') ? 'NVIDIA' : 'AMD';
            const readyPods = ds.status?.numberReady || 0;
            const desiredPods = ds.status?.desiredNumberScheduled || 0;
            devicePlugins.push({
              vendor,
              name,
              status: readyPods > 0 && readyPods >= desiredPods ? 'active' : 'degraded',
              readyPods,
              desiredPods,
            });
          }
        }
      } catch {}

      let totalCapacity = 0;
      let totalAllocatable = 0;
      let vendor = 'none';

      const nodeSummaries = nodes.map((node: any) => {
        const nodeName = node.metadata?.name || 'unknown';
        const capacityObj = node.status?.capacity || {};
        const allocatableObj = node.status?.allocatable || {};

        const nvidiaCap = parseInt(capacityObj['nvidia.com/gpu'] || '0', 10);
        const amdCap = parseInt(capacityObj['amd.com/gpu'] || '0', 10);

        const nvidiaAlloc = parseInt(allocatableObj['nvidia.com/gpu'] || '0', 10);
        const amdAlloc = parseInt(allocatableObj['amd.com/gpu'] || '0', 10);

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
        const phase = pod.status?.phase;
        if (phase === 'Succeeded' || phase === 'Failed') continue;

        const containers = pod.spec?.containers || [];
        let podGpuCount = 0;

        for (const container of containers) {
          const limits = container.resources?.limits || {};
          const requests = container.resources?.requests || {};
          const gpuReq = parseInt(limits['nvidia.com/gpu'] || requests['nvidia.com/gpu'] || limits['amd.com/gpu'] || requests['amd.com/gpu'] || '0', 10);
          podGpuCount += gpuReq;
        }

        if (podGpuCount > 0) {
          totalAllocated += podGpuCount;
          gpuPods.push({
            name: pod.metadata?.name || 'unknown',
            namespace: pod.metadata?.namespace || 'default',
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
    } catch (err: any) {
      this.logger.error(`Failed to get GPU status for cluster ${id}: ${err.message}`);
      return {
        passthroughEnabled: false,
        hasGpu: false,
        vendor: 'none',
        totalCapacity: 0,
        totalAllocatable: 0,
        totalAllocated: 0,
        availableGpus: 0,
        nodes: [],
        devicePlugins: [],
        gpuPods: [],
        error: err.message,
      };
    }
  }
}
