import { Router, type Request, type Response } from 'express';
import {
  afterFailure, lockedSaid, lockedUntil, type SignInAttempts, signJWT, verifyJWT, hashPassword, verifyPassword, type Auth,
  carriedByOAuthState, newOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_SECONDS, sessionToken,
  type Database, type SecretKey,
} from '../../platform/index.js';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { mockOAuthAllowed } from '../lib/oauth-gate.js';
import type { AuthService } from '../services/AuthService.js';

export interface AuthRouterDeps {
  db: Database;
  authService: AuthService;
  auth: Auth;
  sessionKey: SecretKey;
  publicUrl: string;
  appUrl: string;
  accounts?: boolean | undefined;
  hub?: boolean | undefined;
}

export function authRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const accountRoutes = deps.accounts === false ? Router() : router;
  const { db, authService, sessionKey, publicUrl, appUrl } = deps;
  const { setSessionCookie, checkAndConsumeInvite, sessionCookieOptions, getCookie } = deps.auth;
  const startOAuth = (res: Response, invite: string): string => {
    const { state, cookie } = newOAuthState(invite, sessionKey);
    res.cookie(OAUTH_STATE_COOKIE, cookie, { ...sessionCookieOptions, maxAge: OAUTH_STATE_SECONDS * 1000 });
    return encodeURIComponent(state);
  };
  const returnedOAuth = (req: Request, res: Response): { invite: string } | undefined => {
    const held = carriedByOAuthState(getCookie(req, OAUTH_STATE_COOKIE), req.query.state, sessionKey);
    res.clearCookie(OAUTH_STATE_COOKIE, sessionCookieOptions);
    if (!held) res.redirect(`${APP_URL}/?authError=${encodeURIComponent('This sign-in did not start here, or took longer than ten minutes; start it again')}`);
    return held && { invite: held.carried };
  };
  const PUBLIC_URL = publicUrl;
  const APP_URL = appUrl;

  accountRoutes.post('/register', async (req, res) => {
    try {
      let { email, password, inviteCode } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      email = email.trim().toLowerCase();
      const existing = await db.accounts.getUserByEmail(email);
      if (existing) {
        return res.status(400).json({ error: 'User already exists' });
      }

      const isFirstUser = (await db.accounts.getUsers()).length === 0;
      const userId = uuidv4();
      const inviteError = await checkAndConsumeInvite(inviteCode, userId, isFirstUser, email);
      if (inviteError) {
        return res.status(403).json({ error: inviteError });
      }

      const passHash = await hashPassword(password);
      const user = {
        id: userId,
        email,
        passwordHash: passHash,
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
        ...(isFirstUser ? { isAdmin: true } : {}),
      };
      await db.accounts.saveUser(user);
      res.json({ success: true, message: 'User registered successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  const attempts = new Map<string, SignInAttempts>();
  accountRoutes.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
      }
      const account = String(email).trim().toLowerCase();
      const now = Date.now();
      const locked = lockedUntil(attempts.get(account), now);
      if (locked !== undefined) return res.status(429).json({ error: lockedSaid(locked, now) });
      const failed = () => {
        attempts.set(account, afterFailure(attempts.get(account), now));
        return res.status(401).json({ error: 'Invalid email or password' });
      };
      const user = await db.accounts.getUserByEmail(email);
      if (!user || !user.passwordHash) return failed();
      const match = await verifyPassword(password, user.passwordHash);
      if (!match) return failed();
      attempts.delete(account);

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
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
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
      res.json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          twoFactorEnabled: user.twoFactorEnabled,
          isAdmin: user.isAdmin === true,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/logout', (req, res) => {
    res.clearCookie('session', sessionCookieOptions);
    res.json({ success: true });
  });

  router.get('/me', (req, res) => {
    const user = (req as any).user;
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    res.json({
      id: user.id,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorPhone: user.twoFactorPhone,
      twoFactorPreferredMethod: user.twoFactorPreferredMethod,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
      isAdmin: user.isAdmin === true,
      holdsAccounts: deps.accounts !== false,
      ...(deps.hub ? { onHub: true } : {}),
    });
  });

  accountRoutes.post('/sessions/end-others', async (req, res) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      user.sessionsEndedAt = new Date().toISOString();
      await db.accounts.saveUser(user);
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

  accountRoutes.get('/github', (req, res) => {
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const githubId = process.env.GITHUB_CLIENT_ID;
    if (!githubId) {
      if (!mockOAuthAllowed()) {
        return res.status(501).json({ error: 'GitHub sign-in is not configured on this server.' });
      }
      return res.redirect(`${PUBLIC_URL}/api/auth/github/callback?code=mock-github-code&state=${startOAuth(res, invite)}`);
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/auth/github/callback`);
    res.redirect(`https://github.com/login/oauth/authorize?client_id=${githubId}&redirect_uri=${redirectUri}&scope=user:email&state=${startOAuth(res, invite)}`);
  });

  accountRoutes.get('/github/callback', async (req, res) => {
    try {
      const { code } = req.query;
      const returned = returnedOAuth(req, res);
      if (!returned) return;
      let email = 'mock-github-user@example.com';
      let idStr = 'github-mock-id';

      const githubId = process.env.GITHUB_CLIENT_ID;
      const githubSecret = process.env.GITHUB_CLIENT_SECRET;

      const mockRequested = code === 'mock-github-code';
      if (mockRequested && !mockOAuthAllowed()) {
        return res.status(403).json({ error: 'Mock sign-in is disabled on this server.' });
      }
      if (!mockRequested && !(githubId && githubSecret)) {
        return res.status(501).json({ error: 'Github sign-in is not configured on this server.' });
      }

      if (githubId && githubSecret && !mockRequested) {
        const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
          client_id: githubId,
          client_secret: githubSecret,
          code,
        }, { headers: { Accept: 'application/json' } });
        
        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from GitHub');

        const userRes = await axios.get('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const emailRes = await axios.get('https://api.github.com/user/emails', {
          headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'provisioning-platform' },
        });

        const primaryEmailObj = emailRes.data.find((e: any) => e.primary) || emailRes.data[0];
        email = primaryEmailObj?.email || `${userRes.data.login}@github.com`;
        idStr = String(userRes.data.id);
      }

      let user = await db.accounts.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.accounts.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(returned.invite || undefined, userId, isFirstUser, email);
        if (inviteError) {
          return res.redirect(`${APP_URL}/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          githubId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.accounts.saveUser(user);
      } else if (!user.githubId) {
        user.githubId = idStr;
        await db.accounts.saveUser(user);
      }

      const token = sessionToken(user, sessionKey);
      setSessionCookie(res, token);
      res.redirect(`${APP_URL}/`);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  accountRoutes.get('/google', (req, res) => {
    const invite = typeof req.query.invite === 'string' ? req.query.invite : '';
    const googleId = process.env.GOOGLE_CLIENT_ID;
    if (!googleId) {
      if (!mockOAuthAllowed()) {
        return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
      }
      return res.redirect(`${PUBLIC_URL}/api/auth/google/callback?code=mock-google-code&state=${startOAuth(res, invite)}`);
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/auth/google/callback`);
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleId}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile&state=${startOAuth(res, invite)}`);
  });

  accountRoutes.get('/google/callback', async (req, res) => {
    try {
      const { code } = req.query;
      const returned = returnedOAuth(req, res);
      if (!returned) return;
      let email = 'mock-google-user@example.com';
      let idStr = 'google-mock-id';

      const googleId = process.env.GOOGLE_CLIENT_ID;
      const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

      const mockRequested = code === 'mock-google-code';
      if (mockRequested && !mockOAuthAllowed()) {
        return res.status(403).json({ error: 'Mock sign-in is disabled on this server.' });
      }
      if (!mockRequested && !(googleId && googleSecret)) {
        return res.status(501).json({ error: 'Google sign-in is not configured on this server.' });
      }

      if (googleId && googleSecret && !mockRequested) {
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
          client_id: googleId,
          client_secret: googleSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: `${PUBLIC_URL}/api/auth/google/callback`,
        });

        const accessToken = tokenRes.data.access_token;
        if (!accessToken) throw new Error('No access token returned from Google');

        const userRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        email = userRes.data.email;
        idStr = String(userRes.data.id);
      }

      let user = await db.accounts.getUserByEmail(email);
      if (!user) {
        const isFirstUser = (await db.accounts.getUsers()).length === 0;
        const userId = uuidv4();
        const inviteError = await checkAndConsumeInvite(returned.invite || undefined, userId, isFirstUser, email);
        if (inviteError) {
          return res.redirect(`${APP_URL}/?authError=${encodeURIComponent(inviteError)}`);
        }
        user = {
          id: userId,
          email,
          googleId: idStr,
          twoFactorEnabled: false,
          emailVerified: true,
          createdAt: new Date().toISOString(),
          ...(isFirstUser ? { isAdmin: true } : {}),
        };
        await db.accounts.saveUser(user);
      } else if (!user.googleId) {
        user.googleId = idStr;
        await db.accounts.saveUser(user);
      }

      const token = sessionToken(user, sessionKey);
      setSessionCookie(res, token);
      res.redirect(`${APP_URL}/`);
    } catch (err: any) {
      res.status(500).send(`Google OAuth callback failed: ${err.message}`);
    }
  });
  return router;
}
