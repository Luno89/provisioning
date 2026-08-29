import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';

export interface ClusterProvidersRouterDeps {
  db: Database;
}

export function clusterProvidersRouter(deps: ClusterProvidersRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (_req, res) => {
    res.json(await db.getClusterProviders());
  }));

  return router;
}
