import { allowed, asPerson, BaseService, type Database, type DeploymentMetadata, listAt } from '../../platform/index.js';
import { InfrastructureService } from './InfrastructureService.js';
import { ClusterService } from './ClusterService.js';
import { BuilderService } from './BuilderService.js';
import type { TemporalBridge } from './TemporalBridge.js';
import { StorageAdapter } from './StorageAdapter.js';
import { isSelfManagedCluster } from '../lib/cluster-topology.js';
import { listingOf, namespaceOf, namespacesByName, type AppListing, type ClusterRead } from '../lib/app-namespace.js';

export type ListedApp = DeploymentMetadata & { listing: AppListing };
import { appSignIns, PALWORLD_SECRET, secretValues, type AppSignIn } from '../lib/app-sign-in.js';
import { Server as SocketServer } from 'socket.io';

export class AppService extends BaseService {
  private infra: InfrastructureService;
  private clusters: ClusterService;
  private builder: BuilderService;
  private temporalBridge?: Pick<TemporalBridge, 'terminateWorkflow'>;

  constructor(db: Database, infra: InfrastructureService, clusters: ClusterService, builder: BuilderService) {
    super(db);
    this.infra = infra;
    this.clusters = clusters;
    this.builder = builder;
  }

  setTemporalBridge(temporalBridge: Pick<TemporalBridge, 'terminateWorkflow'>) {
    this.temporalBridge = temporalBridge;
  }

  async getById(id: string, userId: string) {
    const deployments = await this.db.infrastructure.getDeployments();
    const dep = deployments.find((d) => d.id === id);
    return dep && allowed(asPerson(userId), 'see', { kind: 'deployment', ownerId: dep.ownerId }) ? dep : undefined;
  }

  async getAll(userId: string): Promise<ListedApp[]> {
    const mine = (await this.db.infrastructure.getDeployments()).filter((dep) => allowed(asPerson(userId), 'see', { kind: 'deployment', ownerId: dep.ownerId }));
    const reads = new Map<string, ClusterRead>();
    await Promise.all([...new Set(mine.map((dep) => dep.clusterId))].map(async (clusterId) => {
      try {
        reads.set(clusterId, { namespaces: new Set(namespacesByName(await this.clusters.access.kubectl(clusterId, ['get', 'namespaces', '-o', 'json'])).keys()) });
      } catch (err) {
        reads.set(clusterId, { unread: (err as Error).message });
      }
    }));
    return mine.map((dep) => ({ ...dep, listing: listingOf(dep, reads.get(dep.clusterId)!) }));
  }

  async updateModules(id: string, modules: string[], userId: string, io?: SocketServer) {
    const dep = await this.getById(id, userId);
    if (!dep) throw new Error('Deployment not found');
    const cluster = await this.clusters.getById(dep.clusterId, asPerson(userId));
    if (!cluster) throw new Error('Cluster not found');

    const updatedMetadata = { ...dep, modules, status: 'deploying' as const };
    await this.db.infrastructure.saveDeployment(updatedMetadata);

    const sanitizedName = namespaceOf(dep);
    const logFile = this.infra.getLogPath(`${dep.name}-update-modules`);

    const appType = dep.appType || 'odoo';
    const webRepo = dep.webRepo || (appType === 'odoo' ? 'library/odoo' : `library/${appType}`);
    const webTag = dep.webTag || (appType === 'odoo' ? '18.0' : 'latest');
    const dbRepo = dep.dbRepo || 'library/postgres';
    const dbTag = dep.dbTag || 'latest';

    (async () => {
        try {
          const baseImage = `${webRepo}:${webTag}`;
          const customTag = await this.builder.buildCustomImage(baseImage, modules, appType, { io, resourceId: id, logFile });
          
          const physicalName = cluster.name;
          const kubeconfigPath = await this.clusters.access.kubeconfigOf(cluster.id);
          const storageEnv = StorageAdapter.getStorageEnv(appType, dep.strategy, dep.storage || {});
          const env: Record<string, string> = {
            STACK_TYPE: 'app',
            CLUSTER_NAME: physicalName,
            DEPLOYMENT_STRATEGY: dep.strategy,
            DEPLOYMENT_NAME: sanitizedName,
            DEPLOYMENT_ID: id.slice(0, 8),
            KUBECONFIG: kubeconfigPath,
            KUBECONFIG_CONTEXT: '',
            SELF_MANAGED_K8S: isSelfManagedCluster(cluster.provider, false) ? 'true' : 'false',
            APP_TYPE: appType,
            WEB_IMAGE_REPO: customTag.split(':')[0] || '',
            WEB_IMAGE_TAG: customTag.split(':')[1] || '',
            DB_IMAGE_REPO: dbRepo,
            DB_IMAGE_TAG: dbTag,
            VPN_ENABLED: dep.vpnEnabled ? 'true' : 'false',
            VPN_PROTOCOL: dep.vpnProtocol || 'wireguard',
            VPN_CONFIG: dep.vpnConfig || '',
            VPN_DEDICATED_IP: dep.vpnDedicatedIp || '',
            ODOO_IMAGE_REPO: customTag.split(':')[0] || '',
            ODOO_IMAGE_TAG: customTag.split(':')[1] || '',
            POSTGRES_IMAGE_REPO: dbRepo,
            POSTGRES_IMAGE_TAG: dbTag,
            ...storageEnv
          };
  
          await this.infra.deploy(`app-${physicalName}-${id.slice(0, 8)}`, { logFile, io, resourceId: id, env });
          await this.db.infrastructure.saveDeployment({ ...updatedMetadata, status: 'running' });
        } catch (err) {
          this.logger.error(`Module update failed: ${(err as Error).message}`);
          await this.db.infrastructure.saveDeployment({ ...updatedMetadata, status: 'failed' });
        }
      })().catch((err: unknown) => this.logger.error(`Unhandled error during module update: ${(err as Error).message}`));

      return updatedMetadata;
  }

  private async onItsCluster(id: string, userId: string): Promise<{ dep: DeploymentMetadata; namespace: string }> {
    const dep = await this.getById(id, userId);
    if (!dep) throw new Error('Deployment not found');
    return { dep, namespace: namespaceOf(dep) };
  }

  async listPods(id: string, userId: string) {
    const { dep, namespace } = await this.onItsCluster(id, userId);
    const output = await this.clusters.access.kubectl(dep.clusterId, ['get', 'pods', '-n', namespace, '-o', 'json']);
    return { pods: listAt(JSON.parse(output) as unknown, 'items'), namespace };
  }

  async signIns(id: string, userId: string): Promise<AppSignIn[] | undefined> {
    const dep = await this.getById(id, userId);
    if (!dep) return undefined;
    if (dep.appType !== 'palworld') return appSignIns(dep);
    const raw = await this.clusters.access.kubectl(dep.clusterId, ['get', 'secret', PALWORLD_SECRET, '-n', namespaceOf(dep), '-o', 'jsonpath={.data}', '--ignore-not-found']);
    return appSignIns(dep, secretValues(raw));
  }

  async getHelmStatus(id: string, userId: string) {
    const { dep, namespace } = await this.onItsCluster(id, userId);
    if (dep.strategy === 'native') return 'Native deployments do not use Helm. Use Diagnostics or Pod Inspector for status.';
    if (!dep.appType) throw new Error(`${dep.name} records no app type, so its Helm release cannot be named`);
    return this.clusters.access.helm(dep.clusterId, ['status', dep.appType, '-n', namespace]);
  }

  async getDiagnostics(id: string, userId: string) {
    const { dep, namespace } = await this.onItsCluster(id, userId);
    const pods = await this.clusters.access.kubectl(dep.clusterId, ['get', 'pods', '-n', namespace, '-o', 'wide']);
    const events = await this.clusters.access.kubectl(dep.clusterId, ['get', 'events', '-n', namespace, '--sort-by=.lastTimestamp', '-o', 'wide']);
    return `--- POD STATUS (Namespace: ${namespace}) ---\n${pods}\n\n--- RECENT EVENTS ---\n${events}`;
  }

  async abort(id: string, userId: string, io?: SocketServer) {
    const dep = await this.getById(id, userId);
    if (!dep) throw new Error('Deployment not found');

    const logFile = this.infra.getLogPath(`${dep.name}-abort`);
    await this.db.infrastructure.saveDeployment({ ...dep, status: 'destroying', lastLogPath: logFile });

    (async () => {
      try {
        if (dep.temporalWorkflowId) {
          if (!this.temporalBridge) throw new Error('this app service was given no Temporal bridge, so the deploy\'s workflow cannot be stopped');
          await this.temporalBridge.terminateWorkflow(dep.temporalWorkflowId, 'User aborted deployment');
        }
        await this.infra.waitForNamespaceDeletion(namespaceOf(dep), await this.clusters.access.kubeconfigOf(dep.clusterId));
        await this.db.infrastructure.deleteDeployment(id);
        if (io) {
          io.to(id).emit('log', '\n--- DEPLOYMENT ABORTED AND CLEANED UP ---\n');
          io.to(`user:${dep.ownerId}`).emit('resource-destroyed', { id, type: 'deployment', name: dep.name });
          io.emit('deployment:updated');
        }
      } catch (err) {
        const reason = (err as Error).message;
        this.logger.error(`Abort failed for deployment ${dep.name}: ${reason}`);
        await this.db.infrastructure.saveDeployment({ ...dep, status: 'failed', healthReason: `stopping it failed: ${reason}`, lastLogPath: logFile });
        if (io) io.emit('deployment:updated');
      }
    })().catch((err: unknown) => this.logger.error(`Unhandled error during deployment abort: ${(err as Error).message}`));
  }
}
