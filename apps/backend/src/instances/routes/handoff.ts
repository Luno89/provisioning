import { Router, type Request, type Response } from 'express';
import { asyncRoute, sessionToken, type SecretKey, type Auth } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';

export function handoffRouter(deps: {
  identity: Pick<IdentityService, 'acceptHandoff' | 'signInUrl' | 'removalUrl' | 'hubUrl'>;
  auth: Pick<Auth, 'setSessionCookie'>;
  sessionKey: SecretKey;
}): Router {
  const router = Router();

  router.get('/sign-in', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.signInUrl() ?? null, hub: deps.identity.hubUrl() ?? null });
  });

  router.get('/account-removal', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.removalUrl() ?? null });
  });

  router.post('/handoff', asyncRoute(async (req: Request, res: Response) => {
    const outcome = await deps.identity.acceptHandoff((req.body ?? {}).token);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    deps.auth.setSessionCookie(res, sessionToken(outcome.user, deps.sessionKey), req);
    return res.json({ user: outcome.user });
  }));

  return router;
}
