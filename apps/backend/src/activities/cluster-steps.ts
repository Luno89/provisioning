import type { ClusterAccess, InfrastructureService } from '../infrastructure/index.js';

export interface ClusterSteps {
  access: ClusterAccess;
  infra: InfrastructureService;
}
