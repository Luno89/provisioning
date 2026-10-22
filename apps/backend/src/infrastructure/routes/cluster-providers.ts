import { Router } from 'express';
import { asyncRoute, type Database } from '../../platform/index.js';

export interface ClusterProvidersRouterDeps {
  db: Database;
}

export function clusterProvidersRouter(deps: ClusterProvidersRouterDeps): Router {
  const { db } = deps;
  const router = Router();

  router.get('/', asyncRoute(async (_req, res) => {
    res.json(await db.infrastructure.getClusterProviders());
  }));

  return router;
}
