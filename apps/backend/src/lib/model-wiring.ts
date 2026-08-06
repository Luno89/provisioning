/**
 * One definition of how a ModelService is built.
 *
 * Exists because model resolution is needed in two places that share no context: the Express
 * bootstrap and `ExecuteLeafActivity`, which runs in a Temporal worker with no server around it.
 *
 * The activity cannot be handed a resolved endpoint instead. An API key is a secret, and secrets
 * must never become workflow arguments — they would be written into Temporal history, replayed on
 * every activation and visible to anything that can read a workflow. So the worker resolves
 * credentials itself, and this is what stops that from meaning a second copy of the wiring that
 * silently drifts from the first.
 */
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
