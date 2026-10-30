import { Router } from 'express';
import { asyncRoute, type Database } from '../../platform/index.js';
import { offeredProviders } from '../lib/cluster-providers.js';

export interface ClusterProvidersRouterDeps {
  db: Database;
}

export function clusterProvidersRouter(deps: ClusterProvidersRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (_req, res) => {
    res.json(offeredProviders(await db.infrastructure.getClusterProviders()));
  }));

  return router;
}
