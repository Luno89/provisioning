import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { ActionDecision, ActionService } from '../services/ActionService.js';

export interface ActionsRouterDeps {
  actions: ActionService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const answer = (res: Response, decided: ActionDecision) =>
  (decided.ok ? res.json(decided.proposal) : res.status(decided.status).json({ error: decided.error }));

export function actionsRouter(deps: ActionsRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const text = (key: string) => (typeof req.query[key] === 'string' ? req.query[key] as string : undefined);
    res.json(await deps.actions.list(userOf(req).id, { conversationId: text('conversationId'), treeId: text('treeId') }));
  }));

  router.post('/:id/apply', asyncRoute(async (req, res) => {
    answer(res, await deps.actions.apply(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.post('/:id/reject', asyncRoute(async (req, res) => {
    answer(res, await deps.actions.reject(userOf(req).id, String(req.params.id ?? '')));
  }));

  return router;
}
