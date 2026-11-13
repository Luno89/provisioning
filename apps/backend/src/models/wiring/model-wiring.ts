import { type SecretKey, type Database, type MeshSettings, type Off, type ClusterSettings, type RoleConfig } from '../../platform/index.js';
import {
  BuilderService, ClusterService, AppService, sharedClusterProxy, HeadscaleService, clusterAccessFrom, type InfrastructureService,
} from '../../infrastructure/index.js';
import { ModelService } from '../services/ModelService.js';
import type { EndpointRules } from '../lib/endpoint-url-safety.js';

export interface ModelServicePlace {
  db: Database;
  dataKey: SecretKey;
  role: RoleConfig;
  clusters: ClusterSettings;
  infra: InfrastructureService;
  mesh: MeshSettings | Off;
  endpointRules: EndpointRules;
  dataDir: string;
}

export function createModelService(place: ModelServicePlace): ModelService {
  const { db, dataKey, role, infra } = place;
  const builder = new BuilderService(db, infra);
  const access = clusterAccessFrom(place.clusters, { role: role.role, clusters: db.infrastructure, dataKey });
  const clusters = new ClusterService(db, access, { instanceOwnerId: role.instance?.ownerId });
  const apps = new AppService(db, infra, clusters, builder);
  const proxy = sharedClusterProxy(access);
  return new ModelService(db, apps, clusters, proxy, new HeadscaleService(dataKey, place.mesh, place.dataDir), dataKey, place.endpointRules);
}
