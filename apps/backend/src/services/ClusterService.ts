import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import type { ClusterMetadata } from '../lib/types.js';
import type { LocalDB } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

export class ClusterService extends BaseService {
  private infra: InfrastructureService;

  constructor(db: LocalDB, infra: InfrastructureService) {
    super(db);
    this.infra = infra;
  }

  async getKubeconfigPath(cluster: ClusterMetadata): Promise<string> {
    if (cluster.provider === 'k3d') {
      const dynamicPath = `/tmp/kubeconfig-${cluster.name}`;
      let exists = false;
      try {
        await fs.access(dynamicPath);
        exists = true;
      } catch {
        exists = false;
      }

      if (!exists) {
        try {
          const content = await this.infra.getKubeconfig(cluster.name);
          await fs.writeFile(dynamicPath, content, 'utf-8');
        } catch (err: any) {
          this.logger.error(`Failed to dynamically fetch kubeconfig for k3d cluster ${cluster.name}: ${err.message}`);
          return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
        }
      }
      return dynamicPath;
    }
    return cluster.kubeconfigPath || DEFAULT_KUBECONFIG;
  }

  async getAll() {
    return this.db.getClusters();
  }

  async getById(id: string) {
    const clusters = await this.db.getClusters();
    return clusters.find((c: any) => c.id === id);
  }

  async provision(name: string, provider: ClusterMetadata['provider'], io?: SocketServer) {
    const id = uuidv4();
    const logFile = this.infra.getLogPath(name);
    const metadata: ClusterMetadata = { id, name, provider, status: 'provisioning', lastLogPath: logFile };
    await this.db.saveCluster(metadata);

    // Run provisioning in background
    (async () => {
      try {
        let kubeconfigPath = DEFAULT_KUBECONFIG;

        if (provider === 'k3d') {
          // 1. Ensure kubeconfig context is clean for this name
          try {
            await this.infra.runKubectl(['config', 'unset', 'clusters.k3d-' + name]);
          } catch {
            // Ignore if it doesn't exist
          }

          // 2. Create the physical k3d cluster
          await this.infra.createLocalCluster(name, { logFile, io, resourceId: id });

          // 3. Dynamically fetch kubeconfig from k3d and write to dedicated local file
          const kubeconfigContent = await this.infra.getKubeconfig(name);
          kubeconfigPath = `/tmp/kubeconfig-${name}`;
          await fs.writeFile(kubeconfigPath, kubeconfigContent, 'utf-8');
        }

        const env: Record<string, string> = { 
          STACK_TYPE: 'cluster', 
          ENV: provider, 
          CLUSTER_NAME: name,
          KUBECONFIG_PATH: kubeconfigPath
        };

        // 4. Deploy the infrastructure stack (Monitoring, etc.)
        await this.infra.deploy(name, { logFile, io, resourceId: id, env });
        await this.db.saveCluster({ ...metadata, status: 'healthy', kubeconfigPath });
      } catch (err: any) {
        this.logger.error(`Provisioning failed: ${err.message}`);
        await this.db.saveCluster({ ...metadata, status: 'failed' });
      }
    })();

    return metadata;
  }

  async delete(id: string, io?: SocketServer) {
    const cluster = await this.getById(id);
    if (!cluster) throw new Error('Cluster not found');

    const logFile = this.infra.getLogPath(`${cluster.name}-destroy`);
    await this.db.saveCluster({ ...cluster, status: 'provisioning', lastLogPath: logFile });

    (async () => {
      try {
        // 1. Destroy infrastructure stack
        await this.infra.destroy(cluster.name, { 
          logFile, io, resourceId: id, 
          env: { STACK_TYPE: 'cluster', ENV: cluster.provider, CLUSTER_NAME: cluster.name }
        });

        // 2. Delete physical k3d cluster if local
        if (cluster.provider === 'k3d') {
            await this.infra.deleteLocalCluster(cluster.name, { logFile, io, resourceId: id });
            try {
                await fs.rm(`/tmp/kubeconfig-${cluster.name}`, { force: true });
            } catch {
                // Ignore
            }
        }

        const clusters = await this.db.getClusters();
        await this.db.saveClusterList(clusters.filter((c: any) => c.id !== id));
        if (io) io.emit('resource-destroyed', { id, type: 'cluster', name: cluster.name });
      } catch (err: any) {
        this.logger.error(`Destruction failed: ${err.message}`);
        await this.db.saveCluster({ ...cluster, status: 'failed' });
      }
    })();
  }

  async listAllPods(id: string) {
    try {
        const cluster = await this.getById(id);
        if (!cluster) throw new Error('Cluster not found');
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
        const args = ['get', 'pods', '--all-namespaces', '-o', 'json'];
        if (context) args.push('--context', context);
        
        const kubeconfigPath = await this.getKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(args, kubeconfigPath);
        return JSON.parse(output).items;
    } catch (err: any) {
        this.logger.error(`Failed to list all pods: ${err.message}`);
        return [];
    }
  }

  async listReleases(id: string) {
    try {
        const cluster = await this.getById(id);
        if (!cluster) throw new Error('Cluster not found');
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
        const args = ['list', '-A', '-o', 'json'];
        if (context) args.push('--kube-context', context);
        
        const kubeconfigPath = await this.getKubeconfigPath(cluster);
        const output = await this.infra.runHelm(args, kubeconfigPath);
        return JSON.parse(output);
    } catch (err: any) {
        this.logger.error(`Failed to list helm releases: ${err.message}`);
        return [];
    }
  }
}
