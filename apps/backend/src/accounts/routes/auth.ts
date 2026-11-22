import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { hashPassword, type Auth,
  asyncRoute, cookieNamed, generateOTP, inviteCodeHash, signInRefusedPage,
  type AccessRevocations, type Database, type SecretKey, principalFrom, sessionView, type Principal, type UserMetadata, type OpenRoute, } from '../../platform/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { AuthService } from '../services/AuthService.js';
import type { PasswordService } from '../services/PasswordService.js';
import type { SignInProviders } from '../services/sign-in/SignInProviders.js';
import { emailProblem, normalEmail, signUpExpiry, signUpLive } from '../lib/sign-up.js';
import { codeHash } from '../lib/codes.js';
import { takenAddressMail } from '../lib/password-reset.js';
import type { OfferedProvider } from '../lib/sign-in-providers.js';
import { confirmWith, twoFactorChangeFrom } from '../lib/second-factor.js';
import { devicesFor } from './device.js';
import { INTERACTION_GONE, PROVIDER_INTERACTION_COOKIE } from './interaction.js';

export interface AccountsSignIn {
  url: string;
  providers: OfferedProvider[];
}

export interface AuthRouterDeps {
  db: Database;
  authService: AuthService;
  auth: Auth;
  sessionKey: SecretKey;
  codeKey: SecretKey;
  appUrl: string;
  start: string;
  interactionPath: string;
  accounts?: boolean | undefined;
  revocations: Pick<AccessRevocations, 'revoked'>;
  providers?: Pick<SignInProviders, 'offered' | 'returnedElsewhere'> | undefined;
  passwords: Pick<PasswordService, 'newPasswordProblem'>;
}

export const AUTH_OPEN: readonly OpenRoute[] = ['/register', '/register/resend', '/sign-in', '/provider/:id/callback'];

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const accountRoutes = deps.accounts === false ? Router() : router;
  const { db, authService, sessionKey, appUrl } = deps;
  const { keptSession, clearSession, checkAndConsumeInvite, inviteProblem, sessionCookieOptions, getCookie } = deps.auth;
  const uidCookie = cookieNamed(PROVIDER_INTERACTION_COOKIE, sessionCookieOptions.secure);
  const devices = devicesFor({ auth: deps.auth, sessionKey, authService });
  const userOf = (req: Request): UserMetadata | undefined => (req as { user?: UserMetadata }).user;
  const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const place = { holdsAccounts: deps.accounts !== false };
  const signedIn = (user: { id: string; email: string; twoFactorEnabled?: boolean | undefined; passwordHash?: string | undefined }, principal: Principal) => ({
    ...sessionView(user, principal, place),
    twoFactorEnabled: user.twoFactorEnabled === true,
    ...(place.holdsAccounts ? { confirmWith: confirmWith(user), hasPassword: Boolean(user.passwordHash) } : {}),
  });
  const APP_URL = appUrl;
  const signUpMail = (email: string, taken: boolean | undefined, sentCode: string) => taken
    ? authService.emailCode(email, takenAddressMail(APP_URL), undefined)
    : authService.sendSignUpCode(email, sentCode);
  const toVerify = (id: string, sending: Awaited<ReturnType<typeof signUpMail>>) => ({ verify: id, ...(sending.kind === 'shown' && sending.code ? { devCode: sending.code } : {}) });

  accountRoutes.post('/register', asyncRoute(async (req, res) => {
    try {
      const { password, inviteCode, email: given } = bodyOf(req);
      const email = normalEmail(given);
      if (!email || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const malformed = emailProblem(email);
      if (malformed) return res.status(400).json({ error: malformed });
      const weak = deps.passwords.newPasswordProblem(password, email);
      if (weak) return res.status(400).json({ error: weak });

      const isFirstUser = (await db.accounts.getUsers()).length === 0;
      const code = typeof inviteCode === 'string' ? inviteCode : undefined;
      if (isFirstUser) {
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(code, userId, true, email);
        if (inviteError) return res.status(403).json({ error: inviteError });
        await db.accounts.saveUser({
          id: userId,
          email,
          passwordHash: await hashPassword(password),
          twoFactorEnabled: false,
          emailVerified: false,
          createdAt: new Date().toISOString(),
          roles: ['operator'],
        });
        return res.json({ success: true, message: 'User registered successfully' });
      }

      const inviteError = await inviteProblem(code, false, email);
      if (inviteError) return res.status(403).json({ error: inviteError });

      const id = uuidv4();
      const taken = Boolean(await db.accounts.getUserByEmail(email));
      const sentCode = generateOTP();
      const sending = await signUpMail(email, taken, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      await db.accounts.savePendingSignUp({
        id,
        email,
        passwordHash: await hashPassword(password),
        inviteHash: inviteCodeHash(code!),
        codeHash: codeHash(deps.codeKey, id, taken ? randomUUID() : sentCode),
        wrong: 0,
        sent: 1,
        expiresAt: signUpExpiry(new Date()),
        ...(taken ? { taken: true } : {}),
      });
      res.json(toVerify(id, sending));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  const pendingFor = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return undefined;
    const pending = await db.accounts.getPendingSignUp(id);
    return signUpLive(pending, new Date()) ? pending : undefined;
  };
  const SIGN_UP_GONE = 'This sign-up has ended; sign up again';

  accountRoutes.post('/register/resend', asyncRoute(async (req, res) => {
    try {
      const pending = await pendingFor(bodyOf(req).id);
      if (!pending) return res.status(410).json({ error: SIGN_UP_GONE });
      const sentCode = generateOTP();
      if (!await db.accounts.newSignUpCode(pending.id, codeHash(deps.codeKey, pending.id, pending.taken ? randomUUID() : sentCode), signUpExpiry(new Date()))) {
        return res.status(429).json({ error: 'We have sent this sign-up enough codes; sign up again' });
      }
      const sending = await signUpMail(pending.email, pending.taken, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      res.json(toVerify(pending.id, sending));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.post('/logout', asyncRoute(async (req, res) => {
    const endSession = await deps.auth.endSession(req);
    clearSession(res);
    res.json({ success: true, ...(endSession ? { endSession } : {}) });
  }));

  router.get('/me', (req, res) => {
    const user = userOf(req);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      ...signedIn(user, principalFrom(req)),
      twoFactorPhone: user.twoFactorPhone,
      twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    });
  });

  accountRoutes.post('/sessions/end-others', asyncRoute(async (req, res) => {
    try {
      const user = userOf(req);
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      await deps.revocations.revoked({ personId: user.id, because: 'signed-out-everywhere', at: new Date().toISOString(), kept: keptSession(req) });
      res.json({ ended: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  accountRoutes.post('/confirm/code', asyncRoute(async (req, res) => {
    const user = userOf(req);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (confirmWith(user) === 'password') return res.status(400).json({ error: 'Confirm with your password; no code is sent for this account' });
    const sent = await authService.sendConfirmCode(user);
    if (sent.kind !== 'sent') return res.status(429).json({ error: sent.said });
    res.json({ sent: true });
  }));

  accountRoutes.post('/2fa/settings', asyncRoute(async (req, res) => {
    try {
      const user = userOf(req);
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const change = twoFactorChangeFrom(req.body);
      if ('problem' in change) return res.status(400).json({ error: change.problem });
      const { enabled, phone, preferredMethod } = change;

      const method = preferredMethod ?? user.twoFactorPreferredMethod ?? 'email';
      const cannot = enabled ? authService.sendingProblem(method) : undefined;
      if (cannot) return res.status(400).json({ error: `Two-factor sign-in stays off: ${cannot}.` });
      const refused = await devices.confirmed(req, user);
      if (refused) return res.status(refused.status).json({ error: refused.error });

      user.twoFactorEnabled = enabled;
      if (phone !== undefined) user.twoFactorPhone = phone;
      if (preferredMethod !== undefined) user.twoFactorPreferredMethod = preferredMethod;

      await db.accounts.saveUser(user);
      await deps.revocations.revoked({ personId: user.id, because: 'password-or-2fa', at: new Date().toISOString(), kept: keptSession(req) });
      res.json({
        id: user.id,
        email: user.email,
        twoFactorEnabled: user.twoFactorEnabled,
        twoFactorPhone: user.twoFactorPhone,
        twoFactorPreferredMethod: user.twoFactorPreferredMethod,
        confirmWith: confirmWith(user),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  accountRoutes.get('/sign-in', (_req, res) => {
    const answer: AccountsSignIn = { url: deps.start, providers: deps.providers ? deps.providers.offered() : [] };
    res.json(answer);
  });

  accountRoutes.get('/provider/:id/callback', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const elsewhere = deps.providers?.returnedElsewhere(req.get('host'), req.originalUrl);
    if (elsewhere) return res.redirect(302, elsewhere);
    const uid = getCookie(req, uidCookie);
    if (!uid || !/^[\w-]+$/.test(uid)) return res.status(400).type('html').send(signInRefusedPage(INTERACTION_GONE, `${APP_URL}/`));
    const search = new URL(req.originalUrl, APP_URL).search;
    return res.redirect(302, `${deps.interactionPath}/${uid}/provider/${encodeURIComponent(String(req.params.id))}/callback${search}`);
  }));
  return router;
}
