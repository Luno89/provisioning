import type { Database } from './db-interface.js';
import { InfrastructureService } from '../services/InfrastructureService.js';
import { BuilderService } from '../services/BuilderService.js';
import { ClusterService } from '../services/ClusterService.js';
import { AppService } from '../services/AppService.js';
import { ClusterProxyService } from '../services/ClusterProxyService.js';
import { HeadscaleService } from '../services/HeadscaleService.js';
import { ModelService } from '../services/ModelService.js';

export function createModelService(db: Database, jwtSecret: string): ModelService {
  const infra = new InfrastructureService();
  const builder = new BuilderService(db, infra);
  const clusters = new ClusterService(db, infra, jwtSecret);
  const apps = new AppService(db, infra, clusters, builder);
  const proxy = new ClusterProxyService();
  const headscale = new HeadscaleService(jwtSecret, process.env.HEADSCALE_URL || 'http://localhost:8080');
  return new ModelService(db, apps, clusters, proxy, headscale, jwtSecret);
}
