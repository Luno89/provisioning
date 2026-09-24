import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { PlanService } from '../services/PlanService.js';

export interface PlansRouterDeps {
  plans: PlanService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const idOf = (req: Request): string => String(req.params.id ?? '');

export function plansRouter(deps: PlansRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
    res.json(await deps.plans.list(userOf(req).id, conversationId));
  }));

  router.get('/:id', asyncRoute(async (req, res) => {
    const proposal = await deps.plans.get(userOf(req).id, idOf(req));
    if (!proposal) return res.status(404).json({ error: 'Plan not found' });
    res.json(proposal);
  }));

  router.post('/:id/approve', asyncRoute(async (req, res) => {
    const decided = await deps.plans.approve(userOf(req).id, idOf(req));
    if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
    res.status(202).json(decided.proposal);
  }));

  router.post('/:id/reject', asyncRoute(async (req, res) => {
    const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
    const decided = await deps.plans.reject(userOf(req).id, idOf(req), reason);
    if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
    res.json(decided.proposal);
  }));

  return router;
}
