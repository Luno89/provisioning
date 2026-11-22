import type { ClusterAccess, InfisicalService, InfrastructureService } from '../infrastructure/index.js';
import type { DatabaseSettings } from '../platform/index.js';
import type { GiteaService } from '../projects/index.js';
import type { MetricsSending } from '../monitoring/index.js';

export interface ClusterSteps {
  access: ClusterAccess;
  infra: InfrastructureService;
  gitea: GiteaService;
  infisical: InfisicalService;
  database: DatabaseSettings;
  machineMetricsUrl: MetricsSending | { off: string };
}
