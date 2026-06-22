import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import { BuilderService } from './BuilderService.js';
import type { DeploymentMetadata, LocalDB } from '../lib/db.js';
import { v4 as uuidv4 } from 'uuid';
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

export class AppService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private builder: BuilderService;

  constructor(db: LocalDB, infra: InfrastructureService, clusters: ClusterService, builder: BuilderService) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.builder = builder;
  }

  async getAll() {
    return this.db.getDeployments();
  }

  private sanitize(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  async deploy(config: any, io?: SocketServer) {
    const { name, clusterId, odooRepo, odooTag, pgRepo, pgTag, strategy = 'helm', modules = [] } = config;
    const cluster = await this.clusters.getById(clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const id = uuidv4();
    const logFile = this.infra.getLogPath(`${name}-deploy`);
    const metadata: DeploymentMetadata = { id, name, clusterId, strategy, status: 'deploying', lastLogPath: logFile, modules };
    await this.db.saveDeployment(metadata);

    const sanitizedName = this.sanitize(name);

    (async () => {
      try {
        let finalOdooRepo = odooRepo;
        let finalOdooTag = odooTag;

        // If modules are selected, we must build a custom image
        if (modules.length > 0) {
            const baseImage = `${odooRepo}:${odooTag}`;
            const customTag = await this.builder.buildCustomImage(baseImage, modules, { io, resourceId: id, logFile });
            
            // Import the image into the k3d cluster
            if (cluster.provider === 'k3d') {
                if (io) io.to(id).emit('log', `\n--- IMPORTING IMAGE INTO K3D: ${customTag} ---\n`);
                await this.infra.importImage(cluster.name, customTag, { logFile, io, resourceId: id });
            }

            finalOdooRepo = customTag.split(':')[0];
            finalOdooTag = customTag.split(':')[1];
        }

        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const env: Record<string, string> = {
          STACK_TYPE: 'app',
          CLUSTER_NAME: cluster.name,
          DEPLOYMENT_STRATEGY: strategy,
          DEPLOYMENT_NAME: sanitizedName,
          DEPLOYMENT_ID: id.slice(0, 8),
          KUBECONFIG: kubeconfigPath,
          KUBECONFIG_CONTEXT: cluster.provider === 'k3d' ? `k3d-${cluster.name}` : '',
          ODOO_IMAGE_REPO: finalOdooRepo || '',
          ODOO_IMAGE_TAG: finalOdooTag || '',
          POSTGRES_IMAGE_REPO: pgRepo || '',
          POSTGRES_IMAGE_TAG: pgTag || ''
        };

        await this.infra.deploy(`app-${cluster.name}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
        await this.db.saveDeployment({ ...metadata, status: 'running', url: 'http://localhost:8069' });
      } catch (err: any) {
        this.logger.error(`App deployment failed: ${err.message}`);
        await this.db.saveDeployment({ ...metadata, status: 'failed' });
      }
    })();

    return metadata;
  }

  async updateModules(id: string, modules: string[], io?: SocketServer) {
    const dep = (await this.getAll()).find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const updatedMetadata = { ...dep, modules, status: 'deploying' as const };
    await this.db.saveDeployment(updatedMetadata);

    const cluster = await this.clusters.getById(dep.clusterId);
    const sanitizedName = this.sanitize(dep.name);
    const logFile = this.infra.getLogPath(`${dep.name}-update-modules`);

    (async () => {
        try {
          // 1. Rebuild the custom image with the new set of modules
          const baseImage = `library/odoo:18.0`; // Should ideally come from deployment metadata
          const customTag = await this.builder.buildCustomImage(baseImage, modules, { io, resourceId: id, logFile });
          
          // 2. Import into cluster
          if (cluster?.provider === 'k3d') {
              await this.infra.importImage(cluster.name, customTag, { logFile, io, resourceId: id });
          }

          const kubeconfigPath = cluster ? await this.clusters.getKubeconfigPath(cluster) : DEFAULT_KUBECONFIG;
          const env: Record<string, string> = {
            STACK_TYPE: 'app',
            CLUSTER_NAME: cluster?.name || '',
            DEPLOYMENT_STRATEGY: dep.strategy,
            DEPLOYMENT_NAME: sanitizedName,
            DEPLOYMENT_ID: id.slice(0, 8),
            KUBECONFIG: kubeconfigPath,
            KUBECONFIG_CONTEXT: cluster?.provider === 'k3d' ? `k3d-${cluster.name}` : '',
            ODOO_IMAGE_REPO: customTag.split(':')[0],
            ODOO_IMAGE_TAG: customTag.split(':')[1]
          };
  
          await this.infra.deploy(`app-${cluster?.name}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
          await this.db.saveDeployment({ ...updatedMetadata, status: 'running' });
        } catch (err: any) {
          this.logger.error(`Module update failed: ${err.message}`);
          await this.db.saveDeployment({ ...updatedMetadata, status: 'failed' });
        }
      })();

      return updatedMetadata;
  }

  async listPods(id: string) {
    try {
        const dep = (await this.getAll()).find((d: any) => d.id === id);
        if (!dep) throw new Error('Deployment not found');
        const cluster = await this.clusters.getById(dep.clusterId);
        if (!cluster) throw new Error('Cluster not found');

        const namespace = this.sanitize(dep.name);
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
        const args = ['get', 'pods', '-n', namespace, '-o', 'json'];
        if (context) args.push('--context', context);

        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(args, kubeconfigPath);
        return { pods: JSON.parse(output).items, namespace };
    } catch (err: any) {
        this.logger.error(`Failed to list pods: ${err.message}`);
        return { pods: [], namespace: 'default' };
    }
  }

  async getHelmStatus(id: string) {
    try {
        const dep = (await this.getAll()).find((d: any) => d.id === id);
        if (!dep) throw new Error('Deployment not found');
        if (dep.strategy === 'native') return 'Native deployments do not use Helm. Use Diagnostics or Pod Inspector for status.';
        
        const cluster = await this.clusters.getById(dep.clusterId);
        if (!cluster) throw new Error('Cluster not found');

        const namespace = this.sanitize(dep.name);
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
        const args = ['status', 'odoo', '-n', namespace];
        if (context) args.push('--kube-context', context);

        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        return await this.infra.runHelm(args, kubeconfigPath);
    } catch (err: any) {
        this.logger.error(`Helm status error: ${err.message}`);
        return 'Helm release not found or not initialized yet.';
    }
  }

  async getDiagnostics(id: string) {
    try {
        const dep = (await this.getAll()).find((d: any) => d.id === id);
        if (!dep) throw new Error('Deployment not found');
        const cluster = await this.clusters.getById(dep.clusterId);
        if (!cluster) throw new Error('Cluster not found');

        const namespace = this.sanitize(dep.name);
        const context = cluster.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
        
        const podsArgs = ['get', 'pods', '-n', namespace, '-o', 'wide'];
        const eventsArgs = ['get', 'events', '-n', namespace, '--sort-by=.lastTimestamp', '-o', 'wide'];
        if (context) {
            podsArgs.push('--context', context);
            eventsArgs.push('--context', context);
        }

        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const pods = await this.infra.runKubectl(podsArgs, kubeconfigPath);
        const events = await this.infra.runKubectl(eventsArgs, kubeconfigPath);

        return `--- POD STATUS (Namespace: ${namespace}) ---\n${pods}\n\n--- RECENT EVENTS ---\n${events}`;
    } catch (err: any) {
        this.logger.error(`Diagnostics error: ${err.message}`);
        return 'Failed to fetch diagnostics.';
    }
  }

  async delete(id: string, io?: SocketServer) {
    const dep = (await this.getAll()).find((d: any) => d.id === id);
    if (!dep) throw new Error('Deployment not found');
    const cluster = await this.clusters.getById(dep.clusterId);
    
    const logFile = this.infra.getLogPath(`${dep.name}-destroy`);
    await this.db.saveDeployment({ ...dep, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        const kubeconfigPath = cluster ? await this.clusters.getKubeconfigPath(cluster) : DEFAULT_KUBECONFIG;
        const env: Record<string, string> = {
          STACK_TYPE: 'app',
          DEPLOYMENT_STRATEGY: dep.strategy,
          DEPLOYMENT_NAME: this.sanitize(dep.name),
          DEPLOYMENT_ID: id.slice(0, 8),
          CLUSTER_NAME: cluster?.name || '',
          KUBECONFIG: kubeconfigPath,
          KUBECONFIG_CONTEXT: cluster?.provider === 'k3d' ? `k3d-${cluster.name}` : ''
        };

        await this.infra.destroy(`app-${cluster?.name}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
        
        try {
            const context = cluster?.provider === 'k3d' ? `k3d-${cluster.name}` : undefined;
            const args = ['delete', 'ns', this.sanitize(dep.name), '--wait=false'];
            if (context) args.push('--context', context);
            await this.infra.runKubectl(args, kubeconfigPath);
        } catch {
            // Ignore if already gone
        }

        const deployments = await this.db.getDeployments();
        await this.db.saveDeploymentList(deployments.filter((d: any) => d.id !== id));
        if (io) io.emit('resource-destroyed', { id, type: 'deployment', name: dep.name });
      } catch (err: any) {
        this.logger.error(`App destruction failed: ${err.message}`);
        await this.db.saveDeployment({ ...dep, status: 'failed' });
      }
    })();
  }
}
