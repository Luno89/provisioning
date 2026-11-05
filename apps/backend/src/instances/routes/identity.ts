import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { isDown, type Reach } from '../lib/instance-watch.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function identityRouter(deps: {
  servesTenants: boolean;
  accounts?: {
    identity: Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'goUrl'>;
    signedIn: (req: Request) => Promise<{ id: string; email: string } | undefined>;
    reachOf?: ((instanceId: string) => Promise<Reach | undefined>) | undefined;
  } | undefined;
}): Router {
  const router = Router();
  const { accounts } = deps;

  router.get('/instance', asyncRoute(async (req: Request, res: Response) => {
    const found = accounts ? await accounts.identity.instanceOf(userOf(req).id) : undefined;
    const reach = found && accounts?.reachOf ? await accounts.reachOf(found.id) : undefined;
    const instance = found ? { id: found.id, url: found.url, ...(isDown(reach) ? { unreachableSince: reach!.unreachableSince } : {}) } : null;
    res.json({ instance, servesTenants: deps.servesTenants });
  }));
  if (!accounts) return router;

  router.get('/keys', (_req: Request, res: Response) => {
    res.json({ keys: accounts.identity.publicKeys() });
  });

  router.get('/go', asyncRoute(async (req: Request, res: Response) => {
    const user = await accounts.signedIn(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return res.redirect(302, '/');
    const toHub = req.query.to === 'hub';
    const url = await accounts.identity.goUrl(user, toHub ? { hub: true, ...(typeof req.query.next === 'string' ? { next: req.query.next } : {}) } : undefined, req.query.nonce);
    if (!url) return res.status(404).json({ error: toHub ? 'this root has no hub' : 'you have no instance yet' });
    return res.redirect(302, url);
  }));

  return router;
}
