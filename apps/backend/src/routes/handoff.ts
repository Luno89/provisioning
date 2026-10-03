import { Router, type Request, type Response } from 'express';
import { asyncRoute } from '../middleware/async-route.js';
import { signJWT } from '../lib/auth.js';
import type { SecretKey } from '../lib/crypto.js';
import type { Auth } from '../middleware/auth.js';
import type { IdentityService } from '../services/IdentityService.js';

export function handoffRouter(deps: {
  identity: Pick<IdentityService, 'acceptHandoff' | 'signInUrl'>;
  auth: Pick<Auth, 'setSessionCookie'>;
  sessionKey: SecretKey;
}): Router {
  const router = Router();

  router.get('/sign-in', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.signInUrl() ?? null });
  });

  router.post('/handoff', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.identity.acceptHandoff((req.body ?? {}).token);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    deps.auth.setSessionCookie(res, signJWT({ userId: outcome.user.id, email: outcome.user.email }, deps.sessionKey, 24 * 60 * 60), req);
    return res.json({ user: outcome.user });
  }));

  return router;
}
