import { Router, type Request, type Response } from 'express';
import { asyncRoute, type Auth } from '../../platform/index.js';
import { asIssuerRequest, LOGOUT_SCRIPT, LOGOUT_SCRIPT_FILE } from '../lib/oidc.js';
import type { RootProvider } from '../services/RootProvider.js';

export function oidcProviderRouter(deps: {
  provider: Pick<RootProvider, 'provider' | 'continueInteraction' | 'issuer' | 'proxied'>;
  auth: Pick<Auth, 'userOf' | 'endSession' | 'clearSession'>;
  interactions: Router;
}): Router {
  const router = Router();

  router.use((req, _res, next) => {
    Object.assign(req.headers, asIssuerRequest(deps.provider.issuer, req.headers, deps.provider.proxied, req.socket.remoteAddress));
    next();
  });

  router.post('/session/end/confirm', asyncRoute(async (req: Request, res: Response, next) => {
    await deps.auth.endSession(req);
    deps.auth.clearSession(res);
    next();
  }));

  router.get(LOGOUT_SCRIPT_FILE, (_req, res) => {
    res.type('application/javascript').send(LOGOUT_SCRIPT);
  });

  router.get('/interaction/:uid', asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const waiting = await deps.provider.continueInteraction(req, res, (await deps.auth.userOf(req))?.id);
    if (waiting) res.redirect(302, `/?resume=${encodeURIComponent(waiting.resume)}`);
  }));

  router.use('/interaction/:uid', deps.interactions);

  router.use(deps.provider.provider.callback());
  return router;
}
