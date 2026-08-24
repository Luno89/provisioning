import express from 'express';
import { verifyJWT } from '../lib/auth.js';
import type { Database } from '../lib/db-interface.js';
import type { UserMetadata } from '../lib/types.js';

/**
 * Who is calling, and may they.
 *
 * ── WHY A FACTORY AND NOT PLAIN EXPORTS ──
 * Every guard here needs `db` and the JWT secret, and both are constructed inside `bootstrap()` —
 * `db` because `createDatabase()` picks MemoryDB or Mongo from the environment, the secret because
 * it is read from `process.env` at boot. Module-level exports would have to reach for a singleton,
 * and the point of the whole extraction is that a test can build one of these over a MemoryDB
 * without booting the application.
 *
 * The three pieces are returned together rather than as separate factories because they are not
 * independent: `requireAuth` and the Socket.IO handshake MUST resolve a session identically, or a
 * socket ends up more (or less) privileged than the browser that opened it. Sharing
 * `userFromSessionCookie` is what makes that structural instead of a convention.
 */

/**
 * One cookie out of a `Cookie:` header.
 *
 * Pure and exported for its own sake — it is the only parsing in the auth path, and it is the kind
 * of function that is quietly wrong (a value containing `=`, a missing header) with no symptom
 * beyond "logged out for no reason".
 */
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
  jwtSecret: string;
  /** The public origin, which decides whether session cookies may be marked `secure`. */
  publicUrl: string;
}

export interface Auth {
  getCookie: (req: express.Request, name: string) => string | undefined;
  userFromSessionCookie: (cookieHeader: string | undefined) => Promise<UserMetadata | undefined>;
  requireAuth: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  setSessionCookie: (res: express.Response, token: string) => void;
  /** The same flags, for `clearCookie` — a logout whose flags differ leaves the cookie in place. */
  sessionCookieOptions: { httpOnly: boolean; secure: boolean; sameSite: 'lax' };
  checkAndConsumeInvite: (
    code: string | undefined,
    newUserId: string,
    isFirstUser: boolean,
  ) => Promise<string | null>;
}

export function createAuth({ db, jwtSecret, publicUrl }: AuthDeps): Auth {
  const getCookie = (req: express.Request, name: string) => parseCookie(req.headers.cookie, name);

  /**
   * Resolves the signed-in user from a session cookie. Shared by requireAuth and the Socket.IO
   * handshake so both accept exactly the same credential.
   */
  async function userFromSessionCookie(cookieHeader: string | undefined): Promise<UserMetadata | undefined> {
    const token = parseCookie(cookieHeader, 'session');
    if (!token) return undefined;
    const decoded = verifyJWT(token, jwtSecret);
    if (!decoded || !decoded.userId) return undefined;
    return await db.getUserById(decoded.userId);
  }

  const requireAuth: express.RequestHandler = async (req, res, next) => {
    const publicPaths = [
      '/auth/login',
      '/auth/register',
      '/auth/2fa/verify',
      '/auth/github',
      '/auth/google',
      '/auth/github/callback',
      '/auth/google/callback',
    ];
    if (publicPaths.includes(req.path)) {
      return next();
    }
    if (process.env.IS_E2E === 'true') {
      const users = await db.getUsers();
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

    if (!getCookie(req, 'session')) {
      return res.status(401).json({ error: 'Unauthorized: Session missing' });
    }
    const user = await userFromSessionCookie(req.headers.cookie);
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

  /**
   * Session cookie flags.
   *
   * `secure` was hardcoded false, which over HTTPS means the session travels in cleartext to any
   * attacker who can force one plain-http request. It has to stay false in dev, where there is no
   * TLS and a secure cookie would simply never be stored — hence keying it off the origin scheme
   * rather than a hardcoded value.
   *
   * `sameSite: 'lax'` is what the browser already defaults to; stating it makes the CORS policy
   * (which reflects any origin) safe to reason about instead of relying on a default.
   */
  const sessionCookieOptions = {
    httpOnly: true,
    secure: publicUrl.startsWith('https://'),
    sameSite: 'lax' as const,
  };
  const setSessionCookie = (res: express.Response, token: string) => {
    res.cookie('session', token, { ...sessionCookieOptions, maxAge: 24 * 60 * 60 * 1000 });
  };

  // This system can spend real money via cloud APIs, so account creation is invite-gated —
  // except the very first user ever, who bootstraps the instance and becomes admin (mirrors
  // migrateLegacyOwnership's backfill logic for pre-existing installs). Consumes the invite
  // (stamps usedBy/usedAt) only on success, so a rejected registration doesn't burn the code.
  async function checkAndConsumeInvite(code: string | undefined, newUserId: string, isFirstUser: boolean): Promise<string | null> {
    if (isFirstUser) return null;
    if (!code) return 'An invite code is required to create an account';
    const invites = await db.getInvites();
    const invite = invites.find((i) => i.code === code);
    if (!invite) return 'Invalid invite code';
    if (invite.usedBy) return 'This invite code has already been used';
    await db.saveInvite({ ...invite, usedBy: newUserId, usedAt: new Date().toISOString() });
    return null;
  }

  return {
    getCookie, userFromSessionCookie, requireAuth, requireAdmin,
    setSessionCookie, sessionCookieOptions, checkAndConsumeInvite,
  };
}
