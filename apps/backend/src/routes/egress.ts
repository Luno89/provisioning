import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { EgressDecision, EgressService } from '../services/EgressService.js';

export interface EgressRouterDeps {
  egress: EgressService;
}

const userOf = (req: Request): { id: string } =>
  (req as unknown as { user: { id: string } }).user;

const answer = (res: Response, decided: EgressDecision) => {
  if (!decided.ok) return res.status(decided.status).json({ error: decided.error });
  return res.json({ ...(decided.request ? { request: decided.request } : {}), ...(decided.grant ? { grant: decided.grant } : {}) });
};

export function egressRouter(deps: EgressRouterDeps): Router {
  const router = Router();
  const text = (req: Request, key: string) => (typeof req.query[key] === 'string' ? req.query[key] as string : undefined);

  router.get('/requests', asyncRoute(async (req, res) => {
    res.json(await deps.egress.requests(userOf(req).id, { conversationId: text(req, 'conversationId'), treeId: text(req, 'treeId') }));
  }));

  router.post('/requests/:id/allow', asyncRoute(async (req, res) => {
    answer(res, await deps.egress.allow(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.post('/requests/:id/dismiss', asyncRoute(async (req, res) => {
    answer(res, await deps.egress.dismiss(userOf(req).id, String(req.params.id ?? '')));
  }));

  router.get('/grants', asyncRoute(async (req, res) => {
    res.json(await deps.egress.grants(userOf(req).id, text(req, 'agent')));
  }));

  router.post('/grants/:id/revoke', asyncRoute(async (req, res) => {
    answer(res, await deps.egress.revoke(userOf(req).id, String(req.params.id ?? '')));
  }));

  return router;
}
