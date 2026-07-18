import { BaseService } from './BaseService.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import { BuilderService } from './BuilderService.js';
import type { Database } from '../lib/db-interface.js';
import type { DeploymentMetadata } from '../lib/types.js';
import { StorageAdapter } from './StorageAdapter.js';
import { v4 as uuidv4 } from 'uuid';
import { Server as SocketServer } from 'socket.io';
import os from 'os';
import path from 'path';

const DEFAULT_KUBECONFIG = path.join(os.homedir(), '.kube/config');

export class AppService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private builder: BuilderService;

  constructor(db: Database, infra: InfrastructureService, clusters: ClusterService, builder: BuilderService) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.builder = builder;
  }

  async getAll(io?: SocketServer) {
    // 1. Force cluster service to sync first, which will also clean up deployments of deleted clusters
    const clusters = await this.clusters.getAll(io);

    // 2. Read the current deployments
    const deployments = await this.db.getDeployments();
    const now = new Date().toISOString();

    // Group deployments by clusterId so we only query each cluster once
    const deploymentsByCluster = new Map<string, typeof deployments>();
    for (const dep of deployments) {
      if (!deploymentsByCluster.has(dep.clusterId)) {
        deploymentsByCluster.set(dep.clusterId, []);
      }
      deploymentsByCluster.get(dep.clusterId)!.push(dep);
    }

    let changed = false;
    const cleanDeployments: typeof deployments = [];

    for (const [clusterId, deps] of deploymentsByCluster.entries()) {
      const cluster = clusters.find(c => c.id === clusterId);
      if (!cluster) {
        changed = true;
        continue;
      }

      if (cluster.status === 'provisioning') {
        cleanDeployments.push(...deps.map(d => ({ ...d, lastSyncedAt: now })));
        continue;
      }

      try {
        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const output = await this.infra.runKubectl(['get', 'ns', '-o', 'json'], kubeconfigPath);
        const data = JSON.parse(output);
        const namespaces = data.items.map((item: any) => item.metadata.name);

        for (const dep of deps) {
          if (dep.status === 'deploying' || dep.status === 'destroying') {
            cleanDeployments.push({ ...dep, lastSyncedAt: now });
            continue;
          }

          const ns = this.sanitize(dep.name);
          if (namespaces.includes(ns)) {
            cleanDeployments.push({ ...dep, lastSyncedAt: now });
          } else {
            changed = true;
            this.logger.info(`Detected deployment ${dep.name} namespace ${ns} deleted outside the system. Syncing...`);
            if (io) {
              io.emit('resource-destroyed', { id: dep.id, type: 'deployment', name: dep.name, outOfBand: true });
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to sync deployments for cluster ${cluster.name}: ${err.message}. Keeping existing metadata.`);
        cleanDeployments.push(...deps.map(d => ({ ...d, lastSyncedAt: now })));
      }
    }

    if (changed) {
      await this.db.saveDeploymentList(cleanDeployments);
    }

    return cleanDeployments;
  }

  async discoverDeployments(clusterId: string): Promise<DeploymentMetadata[]> {
    const cluster = await this.clusters.getById(clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
    const dbDeployments = await this.db.getDeployments();
    const clusterDeployments = dbDeployments.filter(d => d.clusterId === clusterId);
    const now = new Date().toISOString();

    // Get all namespaces (excluding system ones)
    const nsOutput = await this.infra.runKubectl(['get', 'ns', '-o', 'json'], kubeconfigPath);
    const nsData = JSON.parse(nsOutput);
    const userNamespaces = nsData.items
      .map((item: any) => item.metadata.name)
      .filter((n: string) => !n.startsWith('kube-') && n !== 'default' && n !== 'kube-node-lease');

    // Get all helm releases
    let helmReleases: any[] = [];
    try {
      const isMock = this.clusters.isMockCloud(cluster);
      const physicalName = this.clusters.getPhysicalClusterName(cluster);
      const context = (cluster.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : undefined;
      const args = ['list', '-A', '-o', 'json'];
      if (context) args.push('--kube-context', context);
      const helmOutput = await this.infra.runHelm(args, kubeconfigPath);
      helmReleases = JSON.parse(helmOutput);
    } catch {
      // Best-effort: helm may not be available
    }

    const discovered: DeploymentMetadata[] = [];

    for (const ns of userNamespaces) {
      // Skip if already tracked
      const alreadyTracked = clusterDeployments.some(d => this.sanitize(d.name) === ns);
      if (alreadyTracked) continue;

      // Infer appType from helm releases in this namespace
      const nsReleases = helmReleases.filter((r: any) => r.Namespace === ns);
      let appType: DeploymentMetadata['appType'] | undefined;
      let strategy: 'helm' | 'native' = 'native';
      let webRepo: string | undefined;
      let webTag: string | undefined;
      let dbRepo: string | undefined;
      let dbTag: string | undefined;

      if (nsReleases.length > 0) {
        strategy = 'helm';
        const releaseName = nsReleases[0].Chart?.split(':')[0]?.toLowerCase() ?? '';
        const knownApps = ['odoo', 'wordpress', 'nextcloud', 'audiobookshelf', 'prometheus', 'traefik'];
        appType = knownApps.find(a => releaseName.includes(a)) as DeploymentMetadata['appType'] | undefined;
      } else {
        // Try to infer from deployment names in the namespace
        try {
          const podsOutput = await this.infra.runKubectl(['get', 'pods', '-n', ns, '-o', 'json'], kubeconfigPath);
          const podsData = JSON.parse(podsOutput);
          const podNames = podsData.items.map((p: any) => p.metadata.name ?? '').map((n: string) => n.split('-')[0]);
          const knownApps = ['odoo', 'wordpress', 'nextcloud', 'audiobookshelf', 'prometheus', 'traefik'];
          appType = knownApps.find(a => podNames.some((p: string) => p.includes(a))) as DeploymentMetadata['appType'] | undefined;
        } catch {
          // Best-effort
        }
      }

      const entry: DeploymentMetadata = {
        id: uuidv4(),
        name: ns,
        clusterId,
        strategy,
        status: 'running',
        lastSyncedAt: now,
      };
      if (appType) entry.appType = appType;
      if (webRepo) entry.webRepo = webRepo;
      if (webTag) entry.webTag = webTag;
      if (dbRepo) entry.dbRepo = dbRepo;
      if (dbTag) entry.dbTag = dbTag;
      discovered.push(entry);
    }

    if (discovered.length > 0) {
      await this.db.saveDeploymentList([...dbDeployments, ...discovered]);
    }

    return discovered;
  }

  private sanitize(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  async deploy(config: any, io?: SocketServer) {
    const { 
      name, clusterId, odooRepo, odooTag, pgRepo, pgTag, modules = [], appType = 'odoo', storage = {},
      vpnEnabled = false, vpnProtocol = 'wireguard', vpnConfig = '', vpnDedicatedIp = ''
    } = config;
    let strategy = config.strategy || 'helm';
    if (appType === 'odoo') {
      strategy = 'native';
    }
    const cluster = await this.clusters.getById(clusterId);
    if (!cluster) throw new Error('Cluster not found');

    const id = uuidv4();
    const logFile = this.infra.getLogPath(`${name}-deploy`);
    const metadata: DeploymentMetadata = { 
      id, 
      name, 
      clusterId, 
      strategy, 
      appType,
      status: 'deploying', 
      lastLogPath: logFile, 
      modules,
      webRepo: odooRepo,
      webTag: odooTag,
      dbRepo: pgRepo,
      dbTag: pgTag,
      storage,
      vpnEnabled,
      vpnProtocol,
      vpnConfig,
      vpnDedicatedIp
    };
    await this.db.saveDeployment(metadata);

    const sanitizedName = this.sanitize(name);

    (async () => {
      try {
        let finalOdooRepo = odooRepo;
        let finalOdooTag = odooTag;

        // If modules are selected, we must build a custom image
        if (modules.length > 0) {
            const baseImage = `${odooRepo}:${odooTag}`;
            const customTag = await this.builder.buildCustomImage(baseImage, modules, appType, { io, resourceId: id, logFile });
            
            // Import the image into the k3d cluster
            const isMock = this.clusters.isMockCloud(cluster);
            const physicalName = this.clusters.getPhysicalClusterName(cluster);
            if (cluster.provider === 'k3d' || isMock) {
                if (io) io.to(id).emit('log', `\n--- IMPORTING IMAGE INTO K3D: ${customTag} ---\n`);
                await this.infra.importImage(physicalName, customTag, { logFile, io, resourceId: id });
            }

            finalOdooRepo = customTag.split(':')[0] ?? '';
            finalOdooTag = customTag.split(':')[1] ?? '';
        }

        const isMock = this.clusters.isMockCloud(cluster);
        const physicalName = this.clusters.getPhysicalClusterName(cluster);
        const kubeconfigPath = await this.clusters.getKubeconfigPath(cluster);
        const storageEnv = StorageAdapter.getStorageEnv(appType, strategy, storage);
        const env: Record<string, string> = {
          STACK_TYPE: 'app',
          CLUSTER_NAME: physicalName,
          DEPLOYMENT_STRATEGY: strategy,
          DEPLOYMENT_NAME: sanitizedName,
          DEPLOYMENT_ID: id.slice(0, 8),
          KUBECONFIG: kubeconfigPath,
          KUBECONFIG_CONTEXT: (cluster.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : '',
          APP_TYPE: appType,
          WEB_IMAGE_REPO: finalOdooRepo || '',
          WEB_IMAGE_TAG: finalOdooTag || '',
          DB_IMAGE_REPO: pgRepo || '',
          DB_IMAGE_TAG: pgTag || '',
          // VPN Tunneling Configuration
          VPN_ENABLED: vpnEnabled ? 'true' : 'false',
          VPN_PROTOCOL: vpnProtocol,
          VPN_CONFIG: vpnConfig,
          VPN_DEDICATED_IP: vpnDedicatedIp,
          // Backward compatibility for existing stacks
          ODOO_IMAGE_REPO: finalOdooRepo || '',
          ODOO_IMAGE_TAG: finalOdooTag || '',
          POSTGRES_IMAGE_REPO: pgRepo || '',
          POSTGRES_IMAGE_TAG: pgTag || '',
          ...storageEnv
        };

        await this.infra.deploy(`app-${physicalName}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
        const defaultPort = appType === 'odoo' ? '8069' : '80';
        const displayUrl = vpnEnabled && vpnDedicatedIp ? `http://${vpnDedicatedIp}:${defaultPort}` : `http://localhost:${defaultPort}`;
        await this.db.saveDeployment({ ...metadata, status: 'running', url: displayUrl });
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

    const appType = dep.appType || 'odoo';
    const webRepo = dep.webRepo || (appType === 'odoo' ? 'library/odoo' : `library/${appType}`);
    const webTag = dep.webTag || (appType === 'odoo' ? '18.0' : 'latest');
    const dbRepo = dep.dbRepo || 'library/postgres';
    const dbTag = dep.dbTag || 'latest';

    (async () => {
        try {
          // 1. Rebuild the custom image with the new set of modules
          const baseImage = `${webRepo}:${webTag}`;
          const customTag = await this.builder.buildCustomImage(baseImage, modules, appType, { io, resourceId: id, logFile });
          
          // 2. Import into cluster
          const isMock = cluster ? this.clusters.isMockCloud(cluster) : false;
          const physicalName = cluster ? this.clusters.getPhysicalClusterName(cluster) : '';
          if (cluster && (cluster.provider === 'k3d' || isMock)) {
              await this.infra.importImage(physicalName, customTag, { logFile, io, resourceId: id });
          }

          const kubeconfigPath = cluster ? await this.clusters.getKubeconfigPath(cluster) : DEFAULT_KUBECONFIG;
          const storageEnv = StorageAdapter.getStorageEnv(appType, dep.strategy, dep.storage || {});
          const env: Record<string, string> = {
            STACK_TYPE: 'app',
            CLUSTER_NAME: physicalName,
            DEPLOYMENT_STRATEGY: dep.strategy,
            DEPLOYMENT_NAME: sanitizedName,
            DEPLOYMENT_ID: id.slice(0, 8),
            KUBECONFIG: kubeconfigPath,
            KUBECONFIG_CONTEXT: (cluster && (cluster.provider === 'k3d' || isMock)) ? `k3d-${physicalName}` : '',
            APP_TYPE: appType,
            WEB_IMAGE_REPO: customTag.split(':')[0] || '',
            WEB_IMAGE_TAG: customTag.split(':')[1] || '',
            DB_IMAGE_REPO: dbRepo,
            DB_IMAGE_TAG: dbTag,
            // VPN Tunneling Configuration
            VPN_ENABLED: dep.vpnEnabled ? 'true' : 'false',
            VPN_PROTOCOL: dep.vpnProtocol || 'wireguard',
            VPN_CONFIG: dep.vpnConfig || '',
            VPN_DEDICATED_IP: dep.vpnDedicatedIp || '',
            // Backward compatibility
            ODOO_IMAGE_REPO: customTag.split(':')[0] || '',
            ODOO_IMAGE_TAG: customTag.split(':')[1] || '',
            POSTGRES_IMAGE_REPO: dbRepo,
            POSTGRES_IMAGE_TAG: dbTag,
            ...storageEnv
          };
  
          await this.infra.deploy(`app-${physicalName}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
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
        const isMock = this.clusters.isMockCloud(cluster);
        const physicalName = this.clusters.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : undefined;
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
        const isMock = this.clusters.isMockCloud(cluster);
        const physicalName = this.clusters.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : undefined;
        const releaseName = dep.appType || 'odoo';
        const args = ['status', releaseName, '-n', namespace];
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
        const isMock = this.clusters.isMockCloud(cluster);
        const physicalName = this.clusters.getPhysicalClusterName(cluster);
        const context = (cluster.provider === 'k3d' || isMock) ? `k3d-${physicalName}` : undefined;
        
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
        const isMock = cluster ? this.clusters.isMockCloud(cluster) : false;
        const physicalName = cluster ? this.clusters.getPhysicalClusterName(cluster) : '';
        const kubeconfigPath = cluster ? await this.clusters.getKubeconfigPath(cluster) : DEFAULT_KUBECONFIG;
        const env: Record<string, string> = {
          STACK_TYPE: 'app',
          DEPLOYMENT_STRATEGY: dep.strategy,
          DEPLOYMENT_NAME: this.sanitize(dep.name),
          DEPLOYMENT_ID: id.slice(0, 8),
          CLUSTER_NAME: physicalName,
          KUBECONFIG: kubeconfigPath,
          KUBECONFIG_CONTEXT: (cluster && (cluster.provider === 'k3d' || isMock)) ? `k3d-${physicalName}` : ''
        };

        await this.infra.destroy(`app-${physicalName}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
        
        try {
            const context = (cluster && (cluster.provider === 'k3d' || isMock)) ? `k3d-${physicalName}` : undefined;
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

  async resizeDisk(id: string, storage: any, io?: SocketServer) {
    const dep = (await this.getAll()).find(d => d.id === id);
    if (!dep) throw new Error('Deployment not found');

    const updatedMetadata = { ...dep, storage: { ...dep.storage, ...storage }, status: 'deploying' as const };
    await this.db.saveDeployment(updatedMetadata);

    const cluster = await this.clusters.getById(dep.clusterId);
    const sanitizedName = this.sanitize(dep.name);
    const logFile = this.infra.getLogPath(`${dep.name}-resize-disk`);

    const appType = dep.appType || 'odoo';
    const webRepo = dep.webRepo || (appType === 'odoo' ? 'library/odoo' : `library/${appType}`);
    const webTag = dep.webTag || (appType === 'odoo' ? '18.0' : 'latest');
    const dbRepo = dep.dbRepo || 'library/postgres';
    const dbTag = dep.dbTag || 'latest';

    (async () => {
        try {
          const isMock = cluster ? this.clusters.isMockCloud(cluster) : false;
          const physicalName = cluster ? this.clusters.getPhysicalClusterName(cluster) : '';
          const kubeconfigPath = cluster ? await this.clusters.getKubeconfigPath(cluster) : DEFAULT_KUBECONFIG;
          
          const storageEnv = StorageAdapter.getStorageEnv(appType, dep.strategy, updatedMetadata.storage);

          const env: Record<string, string> = {
            STACK_TYPE: 'app',
            CLUSTER_NAME: physicalName,
            DEPLOYMENT_STRATEGY: dep.strategy,
            DEPLOYMENT_NAME: sanitizedName,
            DEPLOYMENT_ID: id.slice(0, 8),
            KUBECONFIG: kubeconfigPath,
            KUBECONFIG_CONTEXT: (cluster && (cluster.provider === 'k3d' || isMock)) ? `k3d-${physicalName}` : '',
            APP_TYPE: appType,
            WEB_IMAGE_REPO: webRepo,
            WEB_IMAGE_TAG: webTag,
            DB_IMAGE_REPO: dbRepo,
            DB_IMAGE_TAG: dbTag,
            ODOO_IMAGE_REPO: webRepo,
            ODOO_IMAGE_TAG: webTag,
            POSTGRES_IMAGE_REPO: dbRepo,
            POSTGRES_IMAGE_TAG: dbTag,
            ...storageEnv
          };
  
          await this.infra.deploy(`app-${physicalName}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
          await this.db.saveDeployment({ ...updatedMetadata, status: 'running' });
        } catch (err: any) {
          this.logger.error(`Disk resize failed: ${err.message}`);
          await this.db.saveDeployment({ ...updatedMetadata, status: 'failed' });
        }
      })();

      return updatedMetadata;
  }
}
