import type crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { HUB_AUDIENCE, hubInstancePart } from '../lib/hub.js';
import { checkMoveToken } from '../lib/identity-token.js';
import type { HubOutcome, HubService, SyncOrigin } from '../services/HubService.js';

const header = (req: Request, name: string): string => String(req.headers[name] ?? '');

const answer = <T>(res: Response, outcome: HubOutcome<T>) => (
  outcome.ok ? res.json(outcome.value) : res.status(outcome.status).json({ error: outcome.why })
);

export function hubInstanceRouter(deps: { hub: Pick<HubService, 'share' | 'unshare' | 'receive' | 'changesSince'>; trusted: ReadonlyMap<string, crypto.KeyObject> }): Router {
  const router = Router();
  const originOf = (req: Request): SyncOrigin | undefined => {
    const instanceId = header(req, 'x-koala-instance');
    const personId = header(req, 'x-koala-person');
    const email = header(req, 'x-koala-email');
    const token = header(req, 'authorization').replace(/^Bearer\s+/i, '');
    if (!instanceId || !personId || !email) return undefined;
    return checkMoveToken(token, deps.trusted, HUB_AUDIENCE, hubInstancePart(instanceId, personId, email)).ok ? { kind: 'instance', instanceId, personId, email } : undefined;
  };
  const withOrigin = (work: (origin: SyncOrigin, req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    const origin = originOf(req);
    if (!origin) return res.status(401).json({ error: 'only an instance root vouches for reaches this' });
    await work(origin, req, res);
  });

  router.post('/share', withOrigin(async (origin, req, res) => answer(res, await deps.hub.share(origin, { name: req.body?.name, projectId: req.body?.projectId }))));
  router.delete('/projects/:id', withOrigin(async (origin, req, res) => answer(res, await deps.hub.unshare(origin, String(req.params.id)))));
  router.post('/projects/:id/changes', withOrigin(async (origin, req, res) => answer(res, await deps.hub.receive(origin, String(req.params.id), req.body?.changes))));
  router.get('/projects/:id/changes', withOrigin(async (origin, req, res) => answer(res, await deps.hub.changesSince(origin, String(req.params.id), Number(req.query.after ?? 0)))));

  return router;
}
