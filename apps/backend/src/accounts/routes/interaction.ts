import { Router, type Request, type Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { v4 as uuidv4 } from 'uuid';
import { asyncRoute, cookieNamed, signInRefusedPage, type Auth, type Database, type SecretKey, type UserMetadata } from '../../platform/index.js';
import type { AuthService } from '../services/AuthService.js';
import type { SignInProviders } from '../services/sign-in/SignInProviders.js';
import { providerStartPath } from '../lib/sign-in-providers.js';
import { normalEmail, SIGN_UP_WRONG_CODES, signUpLive } from '../lib/sign-up.js';
import { sameCode } from '../lib/codes.js';
import type { Devices } from './device.js';

export const PROVIDER_INTERACTION_COOKIE = 'koala_interaction';
export const PROVIDER_INTERACTION_SECONDS = 60 * 60;

export const INTERACTION_GONE = 'This sign-in has ended; sign in again';

export interface SignInInteractions {
  pendingInteraction(req: IncomingMessage, res: ServerResponse): Promise<{ uid: string; held: Record<string, unknown> } | undefined>;
  holdInInteraction(req: IncomingMessage, res: ServerResponse, held: Record<string, unknown>): Promise<void>;
  finishInteraction(req: IncomingMessage, res: ServerResponse, accountId: string): Promise<string>;
}

export interface InteractionRouterDeps {
  db: Database;
  authService: Pick<AuthService, 'checkPassword' | 'sendCode' | 'checkCode'>;
  auth: Pick<Auth, 'checkAndConsumeInvite' | 'claimHeldInvite' | 'sessionCookieOptions'>;
  devices: Pick<Devices, 'known' | 'remember'>;
  codeKey: SecretKey;
  appUrl: string;
  interactions: SignInInteractions;
  providers?: Pick<SignInProviders, 'start' | 'finish' | 'callbackUrl'> | undefined;
}

const SIGN_UP_GONE = 'This sign-up has ended; sign up again';

export function interactionRouter(deps: InteractionRouterDeps): Router {
  const router = Router({ mergeParams: true });
  const { db, authService, interactions, appUrl } = deps;
  const uidCookie = cookieNamed(PROVIDER_INTERACTION_COOKIE, deps.auth.sessionCookieOptions.secure);
  const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const resumeOf = (req: Request, said: Record<string, string>): string =>
    `${appUrl}/?${new URLSearchParams({ resume: req.baseUrl, ...said }).toString()}`;

  const pending = async (req: Request, res: Response) => {
    const found = await interactions.pendingInteraction(req, res);
    return found && found.uid === req.params.uid ? found : undefined;
  };

  const goneAnswered = async (req: Request, res: Response) => {
    const found = await pending(req, res);
    if (!found) res.status(410).json({ error: INTERACTION_GONE });
    return found;
  };

  const finished = async (req: Request, res: Response, user: UserMetadata): Promise<void> => {
    await deps.devices.remember(req, res, user);
    res.json({ next: await interactions.finishInteraction(req, res, user.id) });
  };

  router.post('/login', asyncRoute(async (req, res) => {
    try {
      const { password, email } = bodyOf(req);
      const account = normalEmail(email);
      if (!account || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      if (!await goneAnswered(req, res)) return;
      const user = await db.accounts.getUserByEmail(account);
      const checked = await authService.checkPassword(account, user, password, await deps.devices.known(req), req.ip);
      if (checked.kind === 'locked') return res.status(429).json({ error: checked.said });
      if (checked.kind === 'wrong' || !user) return res.status(401).json({ error: 'Invalid email or password' });
      if (user.removal) return res.status(403).json({ error: 'This account is being removed' });
      if (user.twoFactorEnabled) {
        const sent = await authService.sendCode(user, 'sign-in');
        if (sent.kind === 'locked') return res.status(429).json({ error: sent.said });
        await interactions.holdInInteraction(req, res, { twoFactorFor: user.id });
        return res.json({ twoFactorRequired: true });
      }
      await finished(req, res, user);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.post('/second-factor', asyncRoute(async (req, res) => {
    try {
      const { code } = bodyOf(req);
      if (typeof code !== 'string' || !code) return res.status(400).json({ error: 'The code is required' });
      const interaction = await goneAnswered(req, res);
      if (!interaction) return;
      const userId = interaction.held.twoFactorFor;
      const user = typeof userId === 'string' ? await db.accounts.getUserById(userId) : undefined;
      if (!user || user.removal) return res.status(400).json({ error: 'This sign-in has expired; sign in again' });
      const checked = await authService.checkCode(user.id, 'sign-in', code);
      if (checked.kind === 'locked') return res.status(429).json({ error: checked.said });
      if (checked.kind === 'wrong') return res.status(400).json({ error: 'Invalid or expired 2FA code' });
      await finished(req, res, user);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.post('/sign-up/verify', asyncRoute(async (req, res) => {
    try {
      const { id, code } = bodyOf(req);
      if (typeof code !== 'string' || !/^\s*\d{6}\s*$/.test(code)) {
        return res.status(400).json({ error: 'Enter the six digits from the email' });
      }
      if (!await goneAnswered(req, res)) return;
      const found = typeof id === 'string' && id ? await db.accounts.getPendingSignUp(id) : undefined;
      const pendingSignUp = signUpLive(found, new Date()) ? found : undefined;
      if (!pendingSignUp) return res.status(410).json({ error: SIGN_UP_GONE });
      if (!sameCode(deps.codeKey, pendingSignUp, code)) {
        const wrong = await db.accounts.wrongSignUpCode(pendingSignUp.id);
        if (wrong >= SIGN_UP_WRONG_CODES) {
          await db.accounts.deletePendingSignUp(pendingSignUp.id);
          return res.status(410).json({ error: 'That code was wrong too many times; sign up again' });
        }
        return res.status(401).json({ error: 'That code is not the one we sent; check the email and try again' });
      }
      if (!await db.accounts.deletePendingSignUp(pendingSignUp.id)) return res.status(410).json({ error: SIGN_UP_GONE });
      if (await db.accounts.getUserByEmail(pendingSignUp.email)) return res.status(410).json({ error: SIGN_UP_GONE });
      const userId = uuidv4();
      const inviteError = await deps.auth.claimHeldInvite(pendingSignUp.inviteHash, userId, pendingSignUp.email);
      if (inviteError) return res.status(403).json({ error: inviteError });
      const user: UserMetadata = {
        id: userId,
        email: pendingSignUp.email,
        passwordHash: pendingSignUp.passwordHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      await db.accounts.saveUser(user);
      await finished(req, res, user);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.get('/provider/:id', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!await pending(req, res)) return res.status(410).type('html').send(signInRefusedPage(INTERACTION_GONE, `${appUrl}/`));
    const id = String(req.params.id);
    const started = deps.providers ? await deps.providers.start(id, typeof req.query.invite === 'string' ? req.query.invite : '') : { kind: 'unknown' as const };
    if (started.kind === 'unknown') return res.status(404).json({ error: 'This server does not offer that way to sign in' });
    if (started.kind === 'refused') return res.redirect(302, resumeOf(req, { authError: started.why }));
    await interactions.holdInInteraction(req, res, { provider: started.held });
    res.cookie(uidCookie, String(req.params.uid), { ...deps.auth.sessionCookieOptions, path: '/', maxAge: PROVIDER_INTERACTION_SECONDS * 1000 });
    return res.redirect(302, started.url);
  }));

  router.get('/provider/:id/callback', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.clearCookie(uidCookie, { ...deps.auth.sessionCookieOptions, path: '/' });
    const interaction = await pending(req, res);
    if (!interaction) return res.status(410).type('html').send(signInRefusedPage(INTERACTION_GONE, `${appUrl}/`));
    const id = String(req.params.id);
    const search = new URL(req.originalUrl, appUrl).search;
    const outcome = deps.providers
      ? await deps.providers.finish(id, deps.providers.callbackUrl(`${providerStartPath(id)}/callback${search}`), interaction.held.provider, deps.auth.checkAndConsumeInvite)
      : { kind: 'unknown' as const };
    if (outcome.kind === 'unknown') return res.status(404).json({ error: 'This server does not offer that way to sign in' });
    if (outcome.kind === 'refused') return res.redirect(302, resumeOf(req, { authError: outcome.why }));
    if (outcome.kind === 'second-factor') {
      await interactions.holdInInteraction(req, res, { twoFactorFor: outcome.user.id });
      return res.redirect(302, resumeOf(req, { secondFactor: '1' }));
    }
    return res.redirect(302, await interactions.finishInteraction(req, res, outcome.user.id));
  }));

  return router;
}
