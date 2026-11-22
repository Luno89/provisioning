import express, { Router, type Request, type Response } from 'express';
import { asyncRoute, signInRefusedPage, type BrowserSessions, type OpenRoute } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import type { RootSignIn } from '../services/RootSignIn.js';
import { START_PATH } from '../lib/oidc.js';

export interface InstanceSignIn {
  url: string;
}

export const ROOT_CLIENT_OPEN: readonly OpenRoute[] = ['/oidc/start', '/oidc/callback'];

export const SIGN_IN_OPEN: readonly OpenRoute[] = ['/sign-in', ...ROOT_CLIENT_OPEN, '/oidc/backchannel-logout'];

export interface RootClientRouterDeps {
  signIn: Pick<RootSignIn, 'start' | 'callback'>;
  sessions: Pick<BrowserSessions, 'handle' | 'hold' | 'end'>;
  publicUrl: string;
  landing: string;
}

export function rootClientRouter(deps: RootClientRouterDeps): Router {
  const router = Router();

  router.get('/oidc/start', deps.sessions.handle, asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const started = await deps.signIn.start(req.query.next);
    req.session.signingIn = started.started;
    res.redirect(302, started.url);
  }));

  router.get('/oidc/callback', deps.sessions.handle, asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const signedIn = await deps.signIn.callback(new URL(req.originalUrl, deps.publicUrl), req.session.signingIn);
    if (!signedIn.ok) {
      if (req.session.person) delete req.session.signingIn;
      else await deps.sessions.end(req);
      return res.status(signedIn.status).type('html').send(signInRefusedPage(signedIn.error, START_PATH));
    }
    await deps.sessions.hold(req, signedIn.person);
    return res.redirect(302, `/#${signedIn.next ?? deps.landing}`);
  }));

  return router;
}

export function signInRouter(deps: RootClientRouterDeps & {
  signIn: Pick<RootSignIn, 'backchannel'>;
  identity: Pick<IdentityService, 'removalUrl'>;
}): Router {
  const router = Router();

  router.get('/sign-in', (_req: Request, res: Response) => {
    const answer: InstanceSignIn = { url: START_PATH };
    res.json(answer);
  });

  router.get('/account-removal', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.removalUrl() ?? null });
  });

  router.use(rootClientRouter(deps));

  router.post('/oidc/backchannel-logout', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const outcome = await deps.signIn.backchannel(((req.body ?? {}) as { logout_token?: unknown }).logout_token);
    if (!outcome.ok) return res.status(400).json({ error: 'invalid_request', error_description: outcome.error });
    return res.status(200).end();
  }));

  return router;
}
