import express, { Router, type Request, type Response } from 'express';
import { asyncRoute, cookieNamed, type Auth } from '../../platform/index.js';
import type { IdentityService } from '../services/IdentityService.js';
import { SIGN_IN_COOKIE, type RootSignIn } from '../services/RootSignIn.js';
import { START_PATH } from '../lib/oidc.js';

const escaped = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const refusedPage = (error: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Koala could not sign you in</title><body style="font-family:system-ui;padding:2rem"><p>Koala could not sign you in: ${escaped(error)}</p><p><a href="${START_PATH}">Sign in again</a></p></body>`;

export function signInRouter(deps: {
  signIn: Pick<RootSignIn, 'start' | 'callback' | 'backchannel' | 'startCookieSeconds'>;
  identity: Pick<IdentityService, 'hubUrl' | 'removalUrl'>;
  auth: Pick<Auth, 'setSessionCookie' | 'getCookie' | 'securedFor' | 'sessionCookieOptions'>;
  publicUrl: string;
  landing: string;
}): Router {
  const router = Router();
  const startCookie = (req: Request) => cookieNamed(SIGN_IN_COOKIE, deps.auth.securedFor(req));

  router.get('/sign-in', (_req: Request, res: Response) => {
    res.json({ url: START_PATH, hub: deps.identity.hubUrl() ?? null });
  });

  router.get('/account-removal', (_req: Request, res: Response) => {
    res.json({ url: deps.identity.removalUrl() ?? null });
  });

  router.get('/oidc/start', asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const started = await deps.signIn.start(req.query.next);
    res.cookie(startCookie(req), started.cookie, { ...deps.auth.sessionCookieOptions, secure: deps.auth.securedFor(req), maxAge: deps.signIn.startCookieSeconds * 1000 });
    res.redirect(302, started.url);
  }));

  router.get('/oidc/callback', asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const signedIn = await deps.signIn.callback(new URL(req.originalUrl, deps.publicUrl), deps.auth.getCookie(req, startCookie(req)));
    res.clearCookie(startCookie(req), { ...deps.auth.sessionCookieOptions, secure: deps.auth.securedFor(req) });
    if (!signedIn.ok) return res.status(signedIn.status).type('html').send(refusedPage(signedIn.error));
    deps.auth.setSessionCookie(res, signedIn.token, req);
    return res.redirect(302, `/#${signedIn.next ?? deps.landing}`);
  }));

  router.post('/oidc/backchannel-logout', express.urlencoded({ extended: false, limit: '16kb' }), asyncRoute(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const outcome = await deps.signIn.backchannel(((req.body ?? {}) as { logout_token?: unknown }).logout_token);
    if (!outcome.ok) return res.status(400).json({ error: 'invalid_request', error_description: outcome.error });
    return res.status(200).end();
  }));

  return router;
}
