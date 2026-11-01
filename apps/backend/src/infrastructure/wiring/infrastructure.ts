import { Router, type RequestHandler } from 'express';
import type { Server as SocketServer } from 'socket.io';
import { getTemporalClient, roleFromEnv, startedFor, type Database, type SecretKey } from '../../platform/index.js';
import type { sharedClusterProxy } from '../services/ClusterProxyService.js';
import type { AppExposureService } from '../services/AppExposureService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { CredentialService } from '../services/CredentialService.js';
import type { GiteaService } from '../../projects/index.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { backupRouter } from '../routes/backup.js';
import { clustersRouter } from '../routes/clusters.js';
import { credentialsRouter } from '../routes/credentials.js';
import { dnsProvidersRouter } from '../routes/dns-providers.js';
import { DnsProviders } from '../services/dns/DnsProviders.js';
import { deploymentsRouter } from '../routes/deployments.js';
import { llmCredentialsRouter } from '../../models/index.js';
import type WorkerService from '../services/WorkerService.js';
import type { GitModuleService } from '../services/GitModuleService.js';
import type { RegistryService } from '../services/RegistryService.js';
import type { VpsCatalogService } from '../services/VpsCatalogService.js';
import { appSchemasRouter } from '../routes/app-schemas.js';
import { clusterProvidersRouter } from '../routes/cluster-providers.js';
import { logsRouter } from '../routes/logs.js';
import { modulesRouter } from '../routes/modules.js';
import { nginxRouter } from '../routes/nginx.js';
import { pendingApprovalsRouter } from '../routes/pending-approvals.js';
import { registryRouter } from '../routes/registry.js';
import { temporalRouter } from '../routes/temporal.js';
import { vpsCatalogRouter } from '../routes/vps-catalog.js';
import { workerRouter } from '../routes/worker.js';
import { serverOrdersRouter } from '../routes/server-orders.js';
import { ServerOrderService } from '../services/ServerOrderService.js';
import { rootNodeWorkflowId } from '../lib/server-orders.js';
import { RootNodeWorkflow } from '../../workflows/RootNodeWorkflow.js';
import type { Mounts } from '../../hub/index.js';

export interface InfrastructureWiringDeps {
  tenant: Mounts;
  operatorOnly: RequestHandler;
  db: Database;
  io: SocketServer;
  dataKey: SecretKey;
  sessionKey: SecretKey;
  publicUrl: string;
  appUrl: string;
  repoRoot: string;
  credentials: CredentialService;
  clusters: ClusterService;
  apps: AppService;
  proxy: ReturnType<typeof sharedClusterProxy>;
  infra: InfrastructureService;
  temporalBridge: TemporalBridge;
  gitea: GiteaService;
  infisical: InfisicalService;
  exposure: AppExposureService;
  nginxConfPath: string;
  vpsCatalog: VpsCatalogService;
  worker: WorkerService;
  registry: RegistryService;
  gitModules: GitModuleService;
}

const adminOnly = (operatorOnly: RequestHandler, router: Router): Router => Router().use(operatorOnly, router);

export function wireInfrastructure(deps: InfrastructureWiringDeps): void {
  const { tenant, db, io } = deps;
  tenant.use('/api/credentials', llmCredentialsRouter({ db, dataKey: deps.dataKey, credentialService: deps.credentials, publicUrl: deps.publicUrl, appUrl: deps.appUrl }));
  tenant.use('/api/dns-providers', dnsProvidersRouter({ dns: new DnsProviders() }));
  tenant.use('/api/credentials', credentialsRouter({ credentialService: deps.credentials, publicUrl: deps.publicUrl, appUrl: deps.appUrl, sessionKey: deps.sessionKey }));
  tenant.use('/api/backup', adminOnly(deps.operatorOnly, backupRouter({ repoRoot: deps.repoRoot })));
  tenant.use('/api/clusters', clustersRouter({
    clusterService: deps.clusters, appService: deps.apps, clusterProxyService: deps.proxy, infraService: deps.infra,
    temporalBridge: deps.temporalBridge, db: db.infrastructure, io, giteaService: deps.gitea, infisicalService: deps.infisical, dataKey: deps.dataKey,
  }));
  tenant.use('/api/deployments', deploymentsRouter({
    appService: deps.apps, clusterService: deps.clusters, appExposureService: deps.exposure, infraService: deps.infra, temporalBridge: deps.temporalBridge, db, io,
  }));
  tenant.use('/api/pending-approvals', pendingApprovalsRouter({ db }));
  tenant.use('/api/cluster-providers', clusterProvidersRouter({ db }));
  tenant.use('/api/vps-catalog', vpsCatalogRouter({ vpsCatalogService: deps.vpsCatalog, operatorOnly: deps.operatorOnly }));
  const serverOrders = new ServerOrderService({
    store: db.infrastructure,
    dataKey: deps.dataKey,
    ovhAccountOf: async (ownerId) => {
      const resolved = await deps.credentials.resolveCredentials(ownerId, 'ovh');
      if (resolved.mode === 'mock') return undefined;
      const { OVH_APPLICATION_KEY: applicationKey, OVH_APPLICATION_SECRET: applicationSecret, OVH_CONSUMER_KEY: consumerKey, OVH_SUBSIDIARY: subsidiary } = resolved.env;
      return applicationKey && applicationSecret && consumerKey ? { applicationKey, applicationSecret, consumerKey, subsidiary: subsidiary || 'FR' } : undefined;
    },
    dnsCredentialsOf: (ownerId, provider) => deps.credentials.dnsCredentialsOf(ownerId, provider),
    startFollowing: async (order) => {
      const workflowId = rootNodeWorkflowId(order.id);
      await (await getTemporalClient()).workflow.start(RootNodeWorkflow, {
        workflowId,
        taskQueue: process.env.POOL_TASK_QUEUE || 'host-ops-queue',
        args: [order.id],
        ...startedFor(order.ownerId),
      });
      return workflowId;
    },
    stopFollowing: async (workflowId) => {
      await (await getTemporalClient()).workflow.getHandle(workflowId).cancel();
    },
  });
  if (roleFromEnv(process.env).role === 'combined') tenant.use('/api/server-orders', serverOrdersRouter({ serverOrders, operatorOnly: deps.operatorOnly }));
  tenant.use('/api/temporal', temporalRouter({ temporalBridge: deps.temporalBridge }));
  tenant.use('/api/worker', workerRouter({ workerService: deps.worker, operatorOnly: deps.operatorOnly }));
  tenant.use('/api/nginx', adminOnly(deps.operatorOnly, nginxRouter({ nginxConfPath: deps.nginxConfPath })));
  tenant.use('/api/logs', logsRouter({ db, clusterService: deps.clusters, appService: deps.apps }));
  tenant.use('/api/registry', registryRouter({ registryService: deps.registry }));
  tenant.use('/api/modules', modulesRouter({ gitModuleService: deps.gitModules }));
  tenant.use('/api/app-schemas', appSchemasRouter());
}
