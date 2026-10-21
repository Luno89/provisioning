import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import type { HubOutcome, HubService } from '../services/HubService.js';

const personOf = (req: Request) => {
  const user = (req as unknown as { user: { id: string; email: string } }).user;
  return { id: user.id, email: user.email };
};

const answer = <T>(res: Response, outcome: HubOutcome<T>, status = 200) => (
  outcome.ok ? res.status(status).json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

export function hubRouter(deps: { hub: HubService }): Router {
  const router = Router();

  router.get('/projects', asyncRoute(async (req, res) => {
    res.json(await deps.hub.mine(personOf(req).id));
  }));

  router.get('/projects/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.view(personOf(req).id, param(req, 'id')));
  }));

  router.delete('/projects/:id', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.delete(personOf(req).id, param(req, 'id'), req.body?.name));
  }));

  router.post('/projects/:id/invites', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.invite(personOf(req), param(req, 'id'), { email: req.body?.email, role: req.body?.role }), 201);
  }));

  router.delete('/projects/:id/invites', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.takeBack(personOf(req).id, param(req, 'id'), typeof req.query.email === 'string' ? req.query.email : ''));
  }));

  router.put('/projects/:id/members/:personId', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.changeRole(personOf(req).id, param(req, 'id'), param(req, 'personId'), req.body?.role));
  }));

  router.delete('/projects/:id/members/:personId', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.remove(personOf(req).id, param(req, 'id'), param(req, 'personId')));
  }));

  router.get('/invitations/:token', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.invitation(personOf(req), param(req, 'token')));
  }));

  router.post('/invitations/:token/accept', asyncRoute(async (req, res) => {
    answer(res, await deps.hub.accept(personOf(req), param(req, 'token')));
  }));

  return router;
}
