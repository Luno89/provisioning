import type crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { HUB_AUDIENCE } from '../lib/hub.js';
import { checkMoveToken } from '../lib/identity-token.js';
import { hubPersonPart } from '../services/HubPeople.js';
import type { HubService } from '../services/HubService.js';

export function hubRootRouter(deps: { hub: Pick<HubService, 'leaving' | 'letGo'>; trusted: ReadonlyMap<string, crypto.KeyObject>; forget: (personId: string) => Promise<void> }): Router {
  const router = Router();
  const fromRoot = (req: Request, what: 'leaving' | 'let-go'): boolean => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return checkMoveToken(token, deps.trusted, HUB_AUDIENCE, hubPersonPart(String(req.params.id), what)).ok;
  };

  router.get('/people/:id', asyncRoute(async (req, res) => {
    if (!fromRoot(req, 'leaving')) return res.status(401).json({ error: 'only root asks about a person' });
    res.json(await deps.hub.leaving(String(req.params.id)));
  }));

  router.delete('/people/:id', asyncRoute(async (req, res) => {
    if (!fromRoot(req, 'let-go')) return res.status(401).json({ error: 'only root lets a person go' });
    const id = String(req.params.id);
    const blockers = (await deps.hub.leaving(id)).blockers;
    if (blockers.length > 0) return res.status(409).json({ error: blockers.join('; '), blockers });
    const done = await deps.hub.letGo(id);
    await deps.forget(id);
    res.json(done);
  }));

  return router;
}
