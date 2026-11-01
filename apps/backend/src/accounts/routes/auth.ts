import { Router, type Request } from 'express';
import { randomUUID } from 'node:crypto';
import { signJWT, verifyJWT, hashPassword, type Auth,
  asyncRoute, cookieNamed, generateOTP, inviteCodeHash, OAUTH_STATE_COOKIE, OAUTH_STATE_SECONDS, sessionToken,
  type AccessRevocations, type Database, type SecretKey, principalFrom, sessionView, type Principal, type UserMetadata, } from '../../platform/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { AuthService } from '../services/AuthService.js';
import type { PasswordService } from '../services/PasswordService.js';
import type { SignInProviders } from '../services/sign-in/SignInProviders.js';
import { emailProblem, normalEmail, sameSignUpCode, SIGN_UP_WRONG_CODES, signUpCodeHash, signUpExpiry, signUpLive } from '../lib/sign-up.js';
import { takenAddressMail } from '../lib/password-reset.js';
import { confirmWith, twoFactorChangeFrom } from '../lib/second-factor.js';
import { devicesFor } from './device.js';

const TWO_FACTOR_SECONDS = 5 * 60;

export interface AuthRouterDeps {
  db: Database;
  authService: AuthService;
  auth: Auth;
  sessionKey: SecretKey;
  publicUrl: string;
  appUrl: string;
  accounts?: boolean | undefined;
  hub?: boolean | undefined;
  revocations?: Pick<AccessRevocations, 'revoked'> | undefined;
  providers?: Pick<SignInProviders, 'offered' | 'start' | 'finish'> | undefined;
  passwords: Pick<PasswordService, 'newPasswordProblem'>;
}

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const accountRoutes = deps.accounts === false ? Router() : router;
  const { db, authService, sessionKey, publicUrl, appUrl } = deps;
  const { setSessionCookie, clearSession, checkAndConsumeInvite, inviteProblem, claimHeldInvite, sessionCookieOptions, getCookie } = deps.auth;
  const stateCookie = cookieNamed(OAUTH_STATE_COOKIE, sessionCookieOptions.secure);
  const devices = devicesFor({ auth: deps.auth, sessionKey, authService });
  const rememberDevice = devices.remember;
  const userOf = (req: Request): UserMetadata | undefined => (req as { user?: UserMetadata }).user;
  const bodyOf = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const place = { holdsAccounts: deps.accounts !== false };
  const signedIn = (user: { id: string; email: string; twoFactorEnabled?: boolean | undefined; passwordHash?: string | undefined }, principal: Principal) => ({
    ...sessionView(user, principal, place),
    twoFactorEnabled: user.twoFactorEnabled === true,
    ...(place.holdsAccounts ? { confirmWith: confirmWith(user), hasPassword: Boolean(user.passwordHash) } : {}),
    ...(deps.hub ? { onHub: true } : {}),
  });
  const APP_URL = appUrl;

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
      const sending = taken
        ? await authService.emailCode(email, takenAddressMail(APP_URL), undefined)
        : await authService.sendSignUpCode(email, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      await db.accounts.savePendingSignUp({
        id,
        email,
        passwordHash: await hashPassword(password),
        inviteHash: inviteCodeHash(code!),
        codeHash: signUpCodeHash(id, taken ? randomUUID() : sentCode),
        wrong: 0,
        sent: 1,
        expiresAt: signUpExpiry(new Date()),
        ...(taken ? { taken: true } : {}),
      });
      res.json({ verify: id, ...(sending.kind === 'shown' && sending.code ? { devCode: sending.code } : {}) });
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

  accountRoutes.post('/register/verify', asyncRoute(async (req, res) => {
    try {
      const { id, code } = bodyOf(req);
      if (typeof code !== 'string' || !/^\s*\d{6}\s*$/.test(code)) {
        return res.status(400).json({ error: 'Enter the six digits from the email' });
      }
      const pending = await pendingFor(id);
      if (!pending) return res.status(410).json({ error: SIGN_UP_GONE });
      if (!sameSignUpCode(pending, code)) {
        const wrong = await db.accounts.wrongSignUpCode(pending.id);
        if (wrong >= SIGN_UP_WRONG_CODES) {
          await db.accounts.deletePendingSignUp(pending.id);
          return res.status(410).json({ error: 'That code was wrong too many times; sign up again' });
        }
        return res.status(401).json({ error: 'That code is not the one we sent; check the email and try again' });
      }
      if (!await db.accounts.deletePendingSignUp(pending.id)) return res.status(410).json({ error: SIGN_UP_GONE });
      if (await db.accounts.getUserByEmail(pending.email)) return res.status(410).json({ error: SIGN_UP_GONE });
      const userId = uuidv4();
      const inviteError = await claimHeldInvite(pending.inviteHash, userId, pending.email);
      if (inviteError) return res.status(403).json({ error: inviteError });
      const user = {
        id: userId,
        email: pending.email,
        passwordHash: pending.passwordHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      await db.accounts.saveUser(user);
      setSessionCookie(res, sessionToken(user, sessionKey));
      rememberDevice(req, res, user.email);
      res.json({ success: true, user: signedIn(user, deps.auth.principalFor(user)) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  accountRoutes.post('/register/resend', asyncRoute(async (req, res) => {
    try {
      const pending = await pendingFor(bodyOf(req).id);
      if (!pending) return res.status(410).json({ error: SIGN_UP_GONE });
      const sentCode = generateOTP();
      if (!await db.accounts.newSignUpCode(pending.id, signUpCodeHash(pending.id, pending.taken ? randomUUID() : sentCode), signUpExpiry(new Date()))) {
        return res.status(429).json({ error: 'We have sent this sign-up enough codes; sign up again' });
      }
      const sending = pending.taken
        ? await authService.emailCode(pending.email, takenAddressMail(APP_URL), undefined)
        : await authService.sendSignUpCode(pending.email, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      res.json({ verify: pending.id, ...(sending.kind === 'shown' && sending.code ? { devCode: sending.code } : {}) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  accountRoutes.post('/login', asyncRoute(async (req, res) => {
    try {
      const { password, email } = bodyOf(req);
      const account = normalEmail(email);
      if (!account || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const user = await db.accounts.getUserByEmail(account);
      const checked = await authService.checkPassword(account, user, password, devices.known(req), req.ip);
      if (checked.kind === 'locked') return res.status(429).json({ error: checked.said });
      if (checked.kind === 'wrong' || !user) return res.status(401).json({ error: 'Invalid email or password' });

      if (user.removal) {
        return res.status(403).json({ error: 'This account is being removed' });
      }
      if (user.twoFactorEnabled) {
        const sent = await authService.sendCode(user, 'sign-in');
        if (sent.kind === 'locked') return res.status(429).json({ error: sent.said });
        return res.json({ twoFactorRequired: true, challenge: signJWT('two-factor', { twoFactorFor: user.id }, sessionKey, TWO_FACTOR_SECONDS) });
      }

      setSessionCookie(res, sessionToken(user, sessionKey));
      rememberDevice(req, res, user.email);
      res.json({
        success: true,
        user: signedIn(user, deps.auth.principalFor(user)),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  accountRoutes.post('/2fa/verify', asyncRoute(async (req, res) => {
    try {
      const { challenge, code } = bodyOf(req);
      if (typeof challenge !== 'string' || typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'The sign-in and its code are required' });
      }
      const userId: unknown = verifyJWT(challenge, 'two-factor', sessionKey)?.twoFactorFor;
      const user = typeof userId === 'string' ? await db.accounts.getUserById(userId) : undefined;
      if (!user || user.removal) {
        return res.status(400).json({ error: 'This sign-in has expired; sign in again' });
      }

      const checked = await authService.checkCode(user.id, 'sign-in', code);
      if (checked.kind === 'locked') return res.status(429).json({ error: checked.said });
      if (checked.kind === 'wrong') return res.status(400).json({ error: 'Invalid or expired 2FA code' });

      setSessionCookie(res, sessionToken(user, sessionKey));
      rememberDevice(req, res, user.email);
      res.json({
        success: true,
        user: signedIn(user, deps.auth.principalFor(user)),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  }));

  router.post('/logout', asyncRoute(async (req, res) => {
    await deps.auth.endSession(req);
    clearSession(res);
    res.json({ success: true });
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
      user.sessionsEndedAt = new Date().toISOString();
      await db.accounts.saveUser(user);
      await deps.revocations?.revoked({ personId: user.id, because: 'signed-out-everywhere', at: user.sessionsEndedAt });
      setSessionCookie(res, sessionToken(user, sessionKey), req);
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

      user.sessionsEndedAt = new Date().toISOString();
      user.twoFactorEnabled = enabled;
      if (phone !== undefined) user.twoFactorPhone = phone;
      if (preferredMethod !== undefined) user.twoFactorPreferredMethod = preferredMethod;

      await db.accounts.saveUser(user);
      await deps.revocations?.revoked({ personId: user.id, because: 'password-or-2fa', at: user.sessionsEndedAt });
      setSessionCookie(res, sessionToken(user, sessionKey), req);
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
    res.json({ url: null, providers: deps.providers?.offered() ?? [] });
  });

  accountRoutes.get('/provider/:id', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const started = deps.providers ? await deps.providers.start(String(req.params.id), typeof req.query.invite === 'string' ? req.query.invite : '') : { kind: 'unknown' as const };
    if (started.kind === 'unknown') return res.status(404).json({ error: 'This server does not offer that way to sign in' });
    if (started.kind === 'refused') return res.redirect(302, `${APP_URL}/?authError=${encodeURIComponent(started.why)}`);
    res.cookie(stateCookie, started.cookie, { ...sessionCookieOptions, maxAge: OAUTH_STATE_SECONDS * 1000 });
    return res.redirect(302, started.url);
  }));

  accountRoutes.get('/provider/:id/callback', asyncRoute(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const outcome = deps.providers
      ? await deps.providers.finish(String(req.params.id), new URL(req.originalUrl, publicUrl), getCookie(req, stateCookie), checkAndConsumeInvite)
      : { kind: 'unknown' as const };
    if (outcome.kind === 'unknown') return res.status(404).json({ error: 'This server does not offer that way to sign in' });
    res.clearCookie(stateCookie, sessionCookieOptions);
    if (outcome.kind === 'refused') return res.redirect(302, `${APP_URL}/?authError=${encodeURIComponent(outcome.why)}`);
    if (outcome.kind === 'second-factor') return res.redirect(302, `${APP_URL}/?twoFactor=${encodeURIComponent(signJWT('two-factor', { twoFactorFor: outcome.user.id }, sessionKey, TWO_FACTOR_SECONDS))}`);
    setSessionCookie(res, sessionToken(outcome.user, sessionKey));
    return res.redirect(302, `${APP_URL}/`);
  }));
  return router;
}
