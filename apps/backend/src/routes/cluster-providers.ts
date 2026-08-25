import { Router } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { Database } from '../lib/db-interface.js';

/**
 * The cluster providers this installation can provision onto, as data.
 *
 * Served rather than duplicated in the UI for the same reason persona options are: two lists to
 * keep in step is the failure this codebase already had with leaf columns and with cluster
 * providers themselves — the wizard carried a literal while the backend knew its own providers.
 *
 * Read-only for now: rows change through seeding (lib/cluster-providers.ts) or by hand in the
 * database, not through the API. A write path is a deliberate next step, not an omission.
 */
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
