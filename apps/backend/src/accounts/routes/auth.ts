import { Router, type Request, type Response } from 'express';
import {
  attemptsKeyFor, DEVICE_COOKIE, DEVICE_SECONDS, deviceOf, deviceToken, lockedSaid, SignInAttemptLog, signJWT, verifyJWT, hashPassword, verifyPassword, type Auth,
  asyncRoute, cookieNamed, generateOTP, inviteCodeHash, OAUTH_STATE_COOKIE, OAUTH_STATE_SECONDS, sessionToken,
  type AccessRevocations, type Database, type SecretKey, principalFrom, sessionView, type Principal,
} from '../../platform/index.js';
import { v4 as uuidv4 } from 'uuid';
import type { AuthService } from '../services/AuthService.js';
import type { SignInProviders } from '../services/sign-in/SignInProviders.js';
import { emailProblem, normalEmail, sameSignUpCode, SIGN_UP_WRONG_CODES, signUpCodeHash, signUpExpiry, signUpLive } from '../lib/sign-up.js';

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
}

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const accountRoutes = deps.accounts === false ? Router() : router;
  const { db, authService, sessionKey, publicUrl, appUrl } = deps;
  const { setSessionCookie, clearSession, checkAndConsumeInvite, inviteProblem, claimHeldInvite, sessionCookieOptions, getCookie } = deps.auth;
  const stateCookie = cookieNamed(OAUTH_STATE_COOKIE, sessionCookieOptions.secure);
  const deviceCookie = cookieNamed(DEVICE_COOKIE, sessionCookieOptions.secure);
  const knownDevice = (req: Request) => deviceOf(getCookie(req, deviceCookie), sessionKey);
  const rememberDevice = (req: Request, res: Response, email: string) => {
    const account = email.trim().toLowerCase();
    const known = knownDevice(req);
    res.cookie(deviceCookie, deviceToken(account, sessionKey, known?.account === account ? known.id : undefined), { ...sessionCookieOptions, maxAge: DEVICE_SECONDS * 1000 });
  };
  const place = { holdsAccounts: deps.accounts !== false };
  const signedIn = (user: { id: string; email: string; twoFactorEnabled?: boolean | undefined }, principal: Principal) => ({
    ...sessionView(user, principal, place),
    twoFactorEnabled: user.twoFactorEnabled === true,
    ...(deps.hub ? { onHub: true } : {}),
  });
  const APP_URL = appUrl;

  accountRoutes.post('/register', async (req, res) => {
    try {
      const { password, inviteCode } = req.body;
      const email = normalEmail(req.body.email);
      if (!email || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const malformed = emailProblem(email);
      if (malformed) return res.status(400).json({ error: malformed });
      if (await db.accounts.getUserByEmail(email)) {
        return res.status(400).json({ error: 'User already exists' });
      }

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
      const sentCode = generateOTP();
      const sending = await authService.sendSignUpCode(email, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      await db.accounts.savePendingSignUp({
        id,
        email,
        passwordHash: await hashPassword(password),
        inviteHash: inviteCodeHash(code!),
        codeHash: signUpCodeHash(id, sentCode),
        wrong: 0,
        sent: 1,
        expiresAt: signUpExpiry(new Date()),
      });
      res.json({ verify: id, ...(sending.kind === 'shown' ? { devCode: sending.code } : {}) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const pendingFor = async (id: unknown) => {
    if (typeof id !== 'string' || !id) return undefined;
    const pending = await db.accounts.getPendingSignUp(id);
    return signUpLive(pending, new Date()) ? pending : undefined;
  };
  const SIGN_UP_GONE = 'This sign-up has ended; sign up again';

  accountRoutes.post('/register/verify', async (req, res) => {
    try {
      const { id, code } = req.body;
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
      if (await db.accounts.getUserByEmail(pending.email)) {
        return res.status(400).json({ error: 'User already exists' });
      }
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
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  accountRoutes.post('/register/resend', async (req, res) => {
    try {
      const pending = await pendingFor(req.body.id);
      if (!pending) return res.status(410).json({ error: SIGN_UP_GONE });
      const sentCode = generateOTP();
      if (!await db.accounts.newSignUpCode(pending.id, signUpCodeHash(pending.id, sentCode), signUpExpiry(new Date()))) {
        return res.status(429).json({ error: 'We have sent this sign-up enough codes; sign up again' });
      }
      const sending = await authService.sendSignUpCode(pending.email, sentCode);
      if (sending.kind === 'refused') return res.status(503).json({ error: sending.why });
      res.json({ verify: pending.id, ...(sending.kind === 'shown' ? { devCode: sending.code } : {}) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const attempts = new SignInAttemptLog();
  setInterval(() => attempts.prune(Date.now()), 15 * 60_000).unref();
  accountRoutes.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const account = String(email).trim().toLowerCase();
      const counted = attemptsKeyFor(account, knownDevice(req));
      const now = Date.now();
      const locked = attempts.lockedUntil(counted, now);
      if (locked !== undefined) return res.status(429).json({ error: lockedSaid(locked, now) });
      const failed = () => {
        attempts.failed(counted, now);
        return res.status(401).json({ error: 'Invalid email or password' });
      };
      const user = await db.accounts.getUserByEmail(email);
      if (!user || !user.passwordHash) return failed();
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) return failed();
      attempts.succeeded(counted);

      if (user.removal) {
        return res.status(403).json({ error: 'This account is being removed' });
      }
      if (user.twoFactorEnabled) {
        const code = authService.create2FAChallenge(user.id);
        await authService.send2FACode(user, code);
        return res.json({ twoFactorRequired: true, challenge: signJWT({ twoFactorFor: user.id }, sessionKey, 5 * 60) });
      }

      const token = sessionToken(user, sessionKey);
      setSessionCookie(res, token);
      rememberDevice(req, res, user.email);
      res.json({
        success: true,
        user: signedIn(user, deps.auth.principalFor(user)),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  accountRoutes.post('/2fa/verify', async (req, res) => {
    try {
      const { challenge, code } = req.body;
      if (typeof challenge !== 'string' || typeof code !== 'string' || !code) {
        return res.status(400).json({ error: 'The sign-in and its code are required' });
      }
      const userId = verifyJWT(challenge, sessionKey)?.twoFactorFor;
      if (typeof userId !== 'string') {
        return res.status(400).json({ error: 'This sign-in has expired; sign in again' });
      }
      const user = await db.accounts.getUserById(userId);
      if (!user) {
        return res.status(400).json({ error: 'User not found' });
      }

      const ok = authService.verify2FAChallenge(userId, code);
      if (!ok) {
        return res.status(400).json({ error: 'Invalid or expired 2FA code' });
      }

      const token = sessionToken(user, sessionKey);
      setSessionCookie(res, token);
      rememberDevice(req, res, user.email);
      res.json({
        success: true,
        user: signedIn(user, deps.auth.principalFor(user)),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/logout', (req, res) => {
    clearSession(res);
    res.json({ success: true });
  });

  router.get('/me', (req, res) => {
    const user = (req as any).user;
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

  accountRoutes.post('/sessions/end-others', async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      user.sessionsEndedAt = new Date().toISOString();
      await db.accounts.saveUser(user);
      await deps.revocations?.revoked({ personId: user.id, because: 'signed-out-everywhere', at: user.sessionsEndedAt });
      setSessionCookie(res, sessionToken(user, sessionKey), req);
      res.json({ ended: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  accountRoutes.post('/2fa/settings', async (req, res) => {
    try {
      const { enabled, phone, preferredMethod } = req.body;
      const user = (req as any).user;
      if (!user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const method = preferredMethod ?? user.twoFactorPreferredMethod ?? 'email';
      const cannot = enabled ? authService.sendingProblem(method) : undefined;
      if (cannot) return res.status(400).json({ error: `Two-factor sign-in stays off: ${cannot}.` });

      user.sessionsEndedAt = new Date().toISOString();
      user.twoFactorEnabled = !!enabled;
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
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

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
    if (outcome.kind === 'second-factor') return res.redirect(302, `${APP_URL}/?twoFactor=${encodeURIComponent(signJWT({ twoFactorFor: outcome.user.id }, sessionKey, 5 * 60))}`);
    setSessionCookie(res, sessionToken(outcome.user, sessionKey));
    return res.redirect(302, `${APP_URL}/`);
  }));
  return router;
}
