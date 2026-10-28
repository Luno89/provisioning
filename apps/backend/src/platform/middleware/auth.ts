import express from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { arrivedOverHttps, cookieNamed, SESSION_COOKIE, sessionEnded, signsEveryoneIn, verifyJWT } from '../lib/auth.js';
import { inviteExpired } from '../lib/invite-codes.js';
import { setupCodeProblem } from '../lib/first-admin.js';
import type { Database } from '../lib/db-interface.js';
import type { UserMetadata } from '../lib/types.js';
import type { SecretKey } from '../lib/crypto.js';
import { signsInThroughRoot, type PlatformRole } from '../lib/platform-role.js';

export function parseCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [k, v] = cookie.split('=');
    if (k === name) return v;
  }
  return undefined;
}

export interface AuthDeps {
  db: Database;
  sessionKey: SecretKey;
  publicUrl: string;
  role?: PlatformRole | undefined;
  setupCode?: string | undefined;
}

export interface Auth {
  getCookie: (req: express.Request, name: string) => string | undefined;
  userFromSessionCookie: (cookieHeader: string | undefined, secure: boolean) => Promise<UserMetadata | undefined>;
  securedFor: (arrived: { headers: IncomingHttpHeaders; secure: boolean }) => boolean;
  requireAuth: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  setSessionCookie: (res: express.Response, token: string, req?: express.Request) => void;
  clearSession: (res: express.Response) => void;
  sessionCookieOptions: { httpOnly: boolean; secure: boolean; sameSite: 'lax' };
  checkAndConsumeInvite: (
    code: string | undefined,
    newUserId: string,
    isFirstUser: boolean,
    email?: string,
  ) => Promise<string | null>;
}

export const PUBLIC_PREFIXES = ['/checks/scripted/', '/machines/git/', '/share/'];

export function createAuth({ db, sessionKey, publicUrl, role = 'combined', setupCode }: AuthDeps): Auth {
  const getCookie = (req: express.Request, name: string) => parseCookie(req.headers.cookie, name);

  const sessionCookieOptions = {
    httpOnly: true,
    secure: publicUrl.startsWith('https://'),
    sameSite: 'lax' as const,
  };
  const securedFor = (arrived: { headers: IncomingHttpHeaders; secure: boolean }): boolean =>
    signsInThroughRoot(role) ? arrivedOverHttps(arrived.headers['x-forwarded-proto'], arrived.secure) : sessionCookieOptions.secure;

  async function userFromSessionCookie(cookieHeader: string | undefined, secure: boolean): Promise<UserMetadata | undefined> {
    const token = parseCookie(cookieHeader, cookieNamed(SESSION_COOKIE, secure));
    if (!token) return undefined;
    const decoded = verifyJWT(token, sessionKey);
    if (!decoded || !decoded.userId) return undefined;
    const user = await db.accounts.getUserById(decoded.userId);
    return !user || user.removal || sessionEnded(decoded, user) ? undefined : user;
  }

  const requireAuth: express.RequestHandler = async (req, res, next) => {
    const publicPaths = [
      ...(signsInThroughRoot(role) ? [] : [
        '/hub-link/invite',
        '/hub-link/invitation',
        '/auth/login',
        '/auth/register',
        '/auth/2fa/verify',
        '/auth/github',
        '/auth/google',
        '/auth/github/callback',
        '/auth/google/callback',
        '/identity/keys',
        '/identity/go',
        '/instances/join',
        '/instances/chart.tgz',
        '/instances/release',
        '/instances/status',
        '/instances/machine-key',
        '/instances/machine-node',
        '/instances/addresses',
        '/instances/updates',
        '/instances/groups',
        '/instances/trial',
        '/instances/mail',
        '/instances/hub-token',
        '/instances/monitoring',
        '/instances/move/self',
      ]),
      ...(signsInThroughRoot(role) ? ['/auth/handoff', '/auth/sign-in'] : []),
      '/machines/join',
      '/machines/agent.tgz',
      '/metrics',
    ];
    const publicPrefixes = role === 'instance' ? [...PUBLIC_PREFIXES, '/move/'] : role === 'hub' ? [...PUBLIC_PREFIXES, '/hub-root/', '/hub-instance/'] : [...PUBLIC_PREFIXES, '/instances/monitoring/', '/instances/move/parts/', '/instances/groups/', '/instances/chart/'];
    if (publicPaths.includes(req.path) || publicPrefixes.some((prefix) => req.path.startsWith(prefix))) {
      return next();
    }
    if (signsEveryoneIn(process.env)) {
      const users = await db.accounts.getUsers();
      const mockUser = users[0] || {
        id: 'test-user-id',
        email: 'test@example.com',
        twoFactorEnabled: false,
        emailVerified: true,
        createdAt: new Date().toISOString(),
      };
      (req as any).user = mockUser;
      return next();
    }

    const secure = securedFor(req);
    if (!getCookie(req, cookieNamed(SESSION_COOKIE, secure))) {
      return res.status(401).json({ error: 'Unauthorized: Session missing' });
    }
    const user = await userFromSessionCookie(req.headers.cookie, secure);
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
    }
    (req as any).user = user;
    next();
  };

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (!(req as any).user?.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  };

  const setSessionCookie = (res: express.Response, token: string, req?: express.Request) => {
    const secure = req ? securedFor(req) : sessionCookieOptions.secure;
    res.cookie(cookieNamed(SESSION_COOKIE, secure), token, { ...sessionCookieOptions, secure, maxAge: 24 * 60 * 60 * 1000 });
  };
  const clearSession = (res: express.Response) => {
    res.clearCookie(cookieNamed(SESSION_COOKIE, true), { ...sessionCookieOptions, secure: true });
    res.clearCookie(cookieNamed(SESSION_COOKIE, false), { ...sessionCookieOptions, secure: false });
  };

  async function checkAndConsumeInvite(code: string | undefined, newUserId: string, isFirstUser: boolean, email?: string): Promise<string | null> {
    if (isFirstUser) {
      const refused = setupCodeProblem(setupCode, code);
      if (refused) return refused;
      return await db.accounts.claimFirstAdmin(newUserId, new Date().toISOString()) ? null : 'Someone has just become the first account here; ask them for an invite';
    }
    if (!code) return 'An invite code is required to create an account';
    const invite = await db.accounts.getInviteByCode(code);
    if (!invite) return 'Invalid invite code';
    if (invite.usedBy) return 'This invite code has already been used';
    if (inviteExpired(invite, new Date())) return 'This invite has expired; ask whoever sent it for a new one';
    if (invite.email && (!email || invite.email.trim().toLowerCase() !== email.trim().toLowerCase())) return `This invite is for ${invite.email}; sign up with that address`;
    if (!await db.accounts.claimInvite(code, newUserId, new Date().toISOString())) return 'This invite code has already been used';
    return null;
  }

  return {
    getCookie, userFromSessionCookie, securedFor, requireAuth, requireAdmin,
    setSessionCookie, clearSession, sessionCookieOptions, checkAndConsumeInvite,
  };
}
