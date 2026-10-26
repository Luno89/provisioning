import type { SecretKey, Database } from '../../platform/index.js';
import {
  InfrastructureService, BuilderService, ClusterService, AppService, sharedClusterProxy, HeadscaleService,
} from '../../infrastructure/index.js';
import { ModelService } from '../services/ModelService.js';
import { endpointRulesFromEnv } from '../lib/endpoint-url-safety.js';

export function createModelService(db: Database, jwtSecret: SecretKey): ModelService {
  const infra = new InfrastructureService();
  const builder = new BuilderService(db, infra);
  const clusters = new ClusterService(db, infra, jwtSecret);
  const apps = new AppService(db, infra, clusters, builder);
  const proxy = sharedClusterProxy();
  const headscale = new HeadscaleService(jwtSecret, process.env.HEADSCALE_URL || 'http://localhost:8080', process.env.HEADSCALE_API_KEY);
  return new ModelService(db, apps, clusters, proxy, headscale, jwtSecret, endpointRulesFromEnv(process.env));
}
