import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';

const userOf = (req: Request): { id: string; email: string } =>
  (req as unknown as { user: { id: string; email: string } }).user;

export function identityRouter(deps: {
  identity: Pick<IdentityService, 'publicKeys' | 'instanceOf' | 'handoffUrl'>;
  servesTenants: boolean;
  signedIn: (req: Request) => Promise<{ id: string; email: string } | undefined>;
}): Router {
  const router = Router();

  router.get('/keys', (_req: Request, res: Response) => {
    res.json({ keys: deps.identity.publicKeys() });
  });

  router.get('/instance', asyncRoute(async (req: Request, res: Response) => {
    const instance = await deps.identity.instanceOf(userOf(req).id);
    res.json({ instance: instance ? { id: instance.id, url: instance.url } : null, servesTenants: deps.servesTenants });
  }));

  router.get('/go', asyncRoute(async (req: Request, res: Response) => {
    const user = await deps.signedIn(req);
    res.setHeader('Cache-Control', 'no-store');
    if (!user) return res.redirect(302, '/');
    const toHub = req.query.to === 'hub';
    const url = await deps.identity.handoffUrl(user, toHub ? { hub: true, ...(typeof req.query.next === 'string' ? { next: req.query.next } : {}) } : undefined, req.query.nonce);
    if (!url) return res.status(404).json({ error: toHub ? 'this root has no hub' : 'you have no instance yet' });
    return res.redirect(302, url);
  }));

  return router;
}
