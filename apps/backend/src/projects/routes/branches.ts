import { Router, type Request } from 'express';
import { asyncRoute } from '../../platform/middleware/async-route.js';
import { ownedBy } from '../../platform/lib/ownership.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';
import type { GroveOrderService } from '../services/GroveOrderService.js';
import type { ProjectsStore } from '../store.js';

export interface BranchesRouterDeps {
  db: Pick<ProjectsStore, 'getBranches'>;
  deletion: Pick<GroveDeletionService, 'deleteBranch'>;
  order: Pick<GroveOrderService, 'orderStories'>;
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

  router.put('/:id/order', asyncRoute(async (req, res) => {
    const outcome = await deps.order.orderStories(userOf(req).id, idOf(req), req.body?.leafIds);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json(outcome.value);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const outcome = await deps.deletion.deleteBranch(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
