import { Router, type Request, type Response } from 'express';
import { asyncRoute, cookieNamed, HANDOFF_NONCE_COOKIE, HANDOFF_NONCE_SECONDS, heldHandoffNonce, newHandoffNonce, sessionToken, type SecretKey, type Auth } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';

export function handoffRouter(deps: {
  identity: Pick<IdentityService, 'acceptHandoff' | 'signInUrl' | 'removalUrl' | 'hubUrl' | 'handoffStartUrl'>;
  auth: Pick<Auth, 'setSessionCookie' | 'getCookie' | 'securedFor' | 'sessionCookieOptions'>;
  sessionKey: SecretKey;
}): Router {
  const router = Router();

  router.get('/sign-in', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.signInUrl() ?? null, hub: deps.identity.hubUrl() ?? null });
  });

  router.get('/account-removal', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.removalUrl() ?? null });
  });

  const nonceCookie = (req: Request) => cookieNamed(HANDOFF_NONCE_COOKIE, deps.auth.securedFor(req));

  router.get('/handoff/start', (req: Request, res: Response) => {
    const { nonce, cookie } = newHandoffNonce(deps.sessionKey);
    const url = deps.identity.handoffStartUrl(nonce, req.query.next);
    res.setHeader('Cache-Control', 'no-store');
    if (!url) return res.status(404).json({ error: 'this server signs nobody in through root' });
    const secure = deps.auth.securedFor(req);
    res.cookie(nonceCookie(req), cookie, { ...deps.auth.sessionCookieOptions, secure, maxAge: HANDOFF_NONCE_SECONDS * 1000 });
    return res.redirect(302, url);
  });

  router.post('/handoff', asyncRoute(async (req: Request, res: Response) => {
    const held = heldHandoffNonce(deps.auth.getCookie(req, nonceCookie(req)), deps.sessionKey);
    const outcome = await deps.identity.acceptHandoff((req.body ?? {}).token, held);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error, ...(outcome.restart ? { restart: true } : {}) });
    deps.auth.setSessionCookie(res, sessionToken(outcome.user, deps.sessionKey), req);
    res.clearCookie(nonceCookie(req), { ...deps.auth.sessionCookieOptions, secure: deps.auth.securedFor(req) });
    return res.json({ user: outcome.user });
  }));

  return router;
}
