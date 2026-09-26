import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import type { Database } from '../lib/db-interface.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';

export interface BranchesRouterDeps {
  db: Pick<Database, 'getBranches'>;
  deletion: Pick<GroveDeletionService, 'deleteBranch'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function branchesRouter(deps: BranchesRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const branches = ownedBy(await deps.db.getBranches(), userOf(req).id);
    res.json([...branches].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const outcome = await deps.deletion.deleteBranch(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
