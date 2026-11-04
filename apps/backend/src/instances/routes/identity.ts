import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { isDown, type Reach } from '../lib/instance-watch.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

function answerInstance(servesTenants: boolean, instanceOf?: (req: Request) => Promise<{ id: string; url: string; unreachableSince?: string | undefined } | undefined>) {
  return asyncRoute(async (req: Request, res: Response) => {
    const instance = instanceOf ? await instanceOf(req) : undefined;
    res.json({ instance: instance ?? null, servesTenants });
  });
}

export function identityRouter(deps: {
  identity: Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'goUrl'>;
  servesTenants: boolean;
  signedIn: (req: Request) => Promise<{ id: string; email: string } | undefined>;
  reachOf?: ((instanceId: string) => Promise<Reach | undefined>) | undefined;
}): Router {
  const router = Router();

  router.get('/keys', (_req: Request, res: Response) => {
    res.json({ keys: deps.identity.publicKeys() });
  });

  router.get('/instance', answerInstance(deps.servesTenants, async (req) => {
    const instance = await deps.identity.instanceOf(userOf(req).id);
    if (!instance) return undefined;
    const reach = deps.reachOf ? await deps.reachOf(instance.id) : undefined;
    return { id: instance.id, url: instance.url, ...(isDown(reach) ? { unreachableSince: reach!.unreachableSince } : {}) };
  }));

  router.get('/go', asyncRoute(async (req: Request, res: Response) => {
    const user = await deps.signedIn(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return res.redirect(302, '/');
    const toHub = req.query.to === 'hub';
    const url = await deps.identity.goUrl(user, toHub ? { hub: true, ...(typeof req.query.next === 'string' ? { next: req.query.next } : {}) } : undefined, req.query.nonce);
    if (!url) return res.status(404).json({ error: toHub ? 'this root has no hub' : 'you have no instance yet' });
    return res.redirect(302, url);
  }));

  return router;
}

export function placeRouter(servesTenants: boolean): Router {
  const router = Router();
  router.get('/instance', answerInstance(servesTenants));
  return router;
}
