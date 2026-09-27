import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { AccessDecision, AccessService } from '../services/AccessService.js';

export interface ClusterAccessRouterDeps {
  access: AccessService;
}

const userOf = (req: Request): { id: string; isAdmin?: boolean } =>
  (req as unknown as { user: { id: string; isAdmin?: boolean } }).user;

const answer = (res: Response, decided: AccessDecision) =>
  (decided.ok ? res.json(decided.request) : res.status(decided.status).json({ error: decided.error }));

export function clusterAccessRouter(deps: ClusterAccessRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
    res.json(await deps.access.list(userOf(req).id, conversationId));
  }));

  router.post('/:id/grant', asyncRoute(async (req, res) => {
    answer(res, await deps.access.grant(userOf(req), String(req.params.id ?? '')));
  }));

  router.post('/:id/dismiss', asyncRoute(async (req, res) => {
    answer(res, await deps.access.dismiss(userOf(req).id, String(req.params.id ?? '')));
  }));

  return router;
}
