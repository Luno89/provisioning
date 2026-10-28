import { Router, type Request, type Response } from 'express';
import { asyncRoute, principalFrom } from '../../platform/index.js';
import type { AccessDecision, AccessService } from '../services/AccessService.js';

export interface ClusterAccessRouterDeps {
  access: AccessService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const answer = (res: Response, decided: AccessDecision) =>
  (decided.ok ? res.json(decided.request) : res.status(decided.status).json({ error: decided.error }));

export function clusterAccessRouter(deps: ClusterAccessRouterDeps): Router {
  const router = Router();

  router.get('/', asyncRoute(async (req, res) => {
    const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId : undefined;
    res.json(await deps.access.list(userOf(req).id, conversationId));
  }));

  router.post('/:id/grant', asyncRoute(async (req, res) => {
    answer(res, await deps.access.grant(principalFrom(req), String(req.params.id ?? '')));
  }));

  router.post('/:id/dismiss', asyncRoute(async (req, res) => {
    answer(res, await deps.access.dismiss(userOf(req).id, String(req.params.id ?? '')));
  }));

  return router;
}
