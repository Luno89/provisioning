import type { Server as SocketServer } from 'socket.io';
import type { Database } from '../lib/db-interface.js';
import type { SecretKey } from '../lib/crypto.js';
import type { sharedClusterProxy } from '../services/ClusterProxyService.js';
import type { AppExposureService } from '../services/AppExposureService.js';
import type { AppService } from '../services/AppService.js';
import type { ClusterService } from '../services/ClusterService.js';
import type { CredentialService } from '../services/CredentialService.js';
import type { GiteaService } from '../services/GiteaService.js';
import type { InfisicalService } from '../services/InfisicalService.js';
import type { InfrastructureService } from '../services/InfrastructureService.js';
import type { TemporalBridge } from '../services/TemporalBridge.js';
import { backupRouter } from '../routes/backup.js';
import { clustersRouter } from '../routes/clusters.js';
import { credentialsRouter } from '../routes/credentials.js';
import { deploymentsRouter } from '../routes/deployments.js';
import { llmCredentialsRouter } from '../routes/llm-credentials.js';
import type { Mounts } from './hub.js';

export interface InfrastructureWiringDeps {
  tenant: Mounts;
  db: Database;
  io: SocketServer;
  dataKey: SecretKey;
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
}

export function wireInfrastructure(deps: InfrastructureWiringDeps): void {
  const { tenant, db, io } = deps;
  tenant.use('/api/credentials', llmCredentialsRouter({ db, dataKey: deps.dataKey, credentialService: deps.credentials, publicUrl: deps.publicUrl, appUrl: deps.appUrl }));
  tenant.use('/api/credentials', credentialsRouter({ credentialService: deps.credentials, publicUrl: deps.publicUrl, appUrl: deps.appUrl }));
  tenant.use('/api/backup', backupRouter({ repoRoot: deps.repoRoot }));
  tenant.use('/api/clusters', clustersRouter({
    clusterService: deps.clusters, appService: deps.apps, clusterProxyService: deps.proxy, infraService: deps.infra,
    temporalBridge: deps.temporalBridge, db, io, giteaService: deps.gitea, infisicalService: deps.infisical, dataKey: deps.dataKey,
  }));
  tenant.use('/api/deployments', deploymentsRouter({
    appService: deps.apps, clusterService: deps.clusters, appExposureService: deps.exposure, infraService: deps.infra, temporalBridge: deps.temporalBridge, db, io,
  }));
}
