import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { ownedBy } from '../lib/ownership.js';
import type { Leaf } from '../lib/leaves.js';
import type { Database } from '../lib/db-interface.js';
import type { GroveRunService } from '../services/GroveRunService.js';
import type { GroveDeletionService } from '../services/GroveDeletionService.js';

export interface LeavesRouterDeps {
  db: Pick<Database, 'getLeaves'>;
  runs: Pick<GroveRunService, 'retryLeaf' | 'cancelLeaf' | 'settleClaim'>;
  deletion: Pick<GroveDeletionService, 'deleteLeaf'>;
}

const idOf = (req: Request): string => String(req.params.id ?? '');

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

export function leavesRouter(deps: LeavesRouterDeps): Router {
  const router = Router();

  const ownedLeaf = async (req: Request): Promise<Leaf | undefined> =>
    ownedBy(await deps.db.getLeaves(), userOf(req).id).find((leaf) => leaf.id === idOf(req));

  router.get('/', asyncRoute(async (req, res) => {
    const leaves = ownedBy(await deps.db.getLeaves(), userOf(req).id);
    const branchId = req.query.branchId;
    res.json(typeof branchId === 'string' ? leaves.filter((leaf) => leaf.branchId === branchId) : leaves);
  }));

  router.post('/:id/retry', asyncRoute(async (req, res) => {
    const leaf = await ownedLeaf(req);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const retried = await deps.runs.retryLeaf(userOf(req).id, leaf);
    if (!retried.ok) return res.status(retried.status).json({ error: retried.error });
    res.json(retried.value);
  }));

  router.post('/:id/settle', asyncRoute(async (req, res) => {
    const leaf = await ownedLeaf(req);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const verdict = req.body?.verdict;
    if (verdict !== 'verified' && verdict !== 'failed') return res.status(400).json({ error: "verdict is 'verified' or 'failed'" });
    const note = typeof req.body?.note === 'string' && req.body.note.trim() ? req.body.note.trim() : undefined;
    const settled = await deps.runs.settleClaim(leaf, verdict, note);
    if (!settled.ok) return res.status(settled.status).json({ error: settled.error });
    res.json(settled.value);
  }));

  router.post('/:id/cancel', asyncRoute(async (req, res) => {
    const leaf = await ownedLeaf(req);
    if (!leaf) return res.status(404).json({ error: 'Leaf not found' });
    const cancelled = await deps.runs.cancelLeaf(userOf(req).id, leaf);
    if (!cancelled.ok) return res.status(cancelled.status).json({ error: cancelled.error });
    res.json(cancelled.value);
  }));

  router.delete('/:id', asyncRoute(async (req, res) => {
    const outcome = await deps.deletion.deleteLeaf(userOf(req).id, idOf(req));
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    res.json({ success: true, stoppedRun: outcome.value.stoppedRun, deleted: outcome.value.scope });
  }));

  return router;
}
