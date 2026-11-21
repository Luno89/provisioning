import express from 'express';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { arrivedOverHttps, cookieNamed } from '../lib/auth.js';
import { BROWSER_SESSION_COOKIE, type BrowserPerson, type PersonThroughRoot } from '../lib/browser-session.js';
import type { BrowserSessions } from '../services/BrowserSessions.js';
import type { AccessRevocations } from '../services/AccessRevocations.js';
import { inviteCodeHash, inviteExpired } from '../lib/invite-codes.js';
import { setupCodeProblem } from '../lib/first-admin.js';
import type { Database } from '../lib/db-interface.js';
import type { InviteMetadata, UserMetadata } from '../lib/types.js';
import { signsInThroughRoot, type PlatformRole } from '../lib/platform-role.js';
import { authorize, principalOf, type Actions, type BearerSignIn, type Principal, type Resource } from '../lib/permissions.js';

export interface ThroughRoot {
  sessions: BrowserSessions;
  signIn: PersonThroughRoot;
}

export interface OwnSessions {
  sessions: BrowserSessions;
  revocations: Pick<AccessRevocations, 'listen'>;
}

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
  publicUrl: string;
  role: PlatformRole;
  instanceOwnerId?: string | undefined;
  setupCode?: string | undefined;
  throughRoot?: ThroughRoot | undefined;
  bearer?: ((token: string) => Promise<BearerSignIn>) | undefined;
  own?: OwnSessions | undefined;
  open: readonly OpenMount[];
}

export const requireAllowed = <R extends Resource>(action: Actions[R['kind']], resource: R): express.RequestHandler => (req, res, next) => {
  const principal = (req as { principal?: Principal }).principal;
  const decision = principal ? authorize(principal, action, resource) : undefined;
  if (!decision?.allowed) return res.status(decision && !decision.allowed ? decision.status : 401).json({ error: decision && !decision.allowed ? decision.error : 'Sign in first' });
  next();
};

interface SignedIn {
  user: UserMetadata;
  principal: Principal;
  sessionId?: string | undefined;
}

const signedIn = (req: express.Request, fields: SignedIn): void => {
  Object.assign(req, fields);
};

export function principalFrom(req: express.Request): Principal {
  const principal = (req as { principal?: Principal }).principal;
  if (!principal) throw new Error(`${req.method} ${req.path} reached a route that needs a signed-in person without one`);
  return principal;
}

export interface Auth {
  getCookie: (req: express.Request, name: string) => string | undefined;
  userOf: (req: express.Request) => Promise<UserMetadata | undefined>;
  sessionOf: (req: IncomingMessage) => Promise<{ user: UserMetadata; sessionId: string; sessionAt: number } | undefined>;
  sessionHandle: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  securedFor: (arrived: { headers: IncomingHttpHeaders; secure: boolean }) => boolean;
  requireAuth: express.RequestHandler;
  requireOperator: (action: Actions['install']) => express.RequestHandler;
  principalFor: (user: Pick<UserMetadata, 'id' | 'roles'>) => Principal;
  holdAccount: (req: express.Request, user: Pick<UserMetadata, 'id'>) => Promise<void>;
  clearSession: (res: express.Response) => void;
  endSession: (req: express.Request) => Promise<string | undefined>;
  sessionCookieOptions: { httpOnly: boolean; secure: boolean; sameSite: 'lax' };
  checkAndConsumeInvite: (
    code: string | undefined,
    newUserId: string,
    isFirstUser: boolean,
    email?: string,
  ) => Promise<string | null>;
  inviteProblem: (code: string | undefined, isFirstUser: boolean, email: string) => Promise<string | null>;
  claimHeldInvite: (codeHash: string, newUserId: string, email: string) => Promise<string | null>;
}

export type OpenRoute = string | RegExp;

export interface OpenMount {
  mount: `/${string}`;
  routes: readonly OpenRoute[];
}

function openedBy(open: readonly OpenMount[]): (req: express.Request, res: express.Response) => Promise<boolean> {
  const opened = express.Router();
  const marked = new WeakSet<express.Request>();
  const mark: express.RequestHandler = (req, _res, next) => {
    marked.add(req);
    next('router');
  };
  for (const { mount, routes } of open) {
    const under = express.Router();
    for (const route of routes) under.all(route, mark);
    opened.use(mount, under);
  }
  return (req, res) => new Promise((resolve, reject) => {
    opened(req, res, (err?: unknown) => {
      if (err && err !== 'router') reject(err instanceof Error ? err : new Error(String(err)));
      else resolve(marked.has(req));
    });
  });
}

const userOfPerson = (person: BrowserPerson): UserMetadata => ({
  id: person.sub,
  email: person.email,
  emailVerified: true,
  twoFactorEnabled: false,
  createdAt: new Date(person.sessionAt).toISOString(),
});

type HeldRequest = IncomingMessage & Pick<express.Request, 'session' | 'sessionID'>;

const ran = (handle: Auth['sessionHandle'], req: IncomingMessage, res: ServerResponse): Promise<void> =>
  new Promise((resolve, reject) => { handle(req, res, (err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())); });

const noSessions = (role: PlatformRole): never => {
  throw new Error(`a ${role} was given no browser sessions to sign people in with`);
};

export function createAuth({ db, publicUrl, role, instanceOwnerId, setupCode, throughRoot, bearer, own, open }: AuthDeps): Auth {
  if (signsInThroughRoot(role) && (!throughRoot || own)) throw new Error(`a ${role} signs people in only through root, so it is given root's sessions and no sessions of its own`);
  if (!signsInThroughRoot(role) && (throughRoot || !own)) throw new Error(`a ${role} keeps its own sessions, so it is given those and none through root`);
  const sessions = throughRoot?.sessions ?? own?.sessions ?? noSessions(role);
  own?.revocations.listen(async (revoked) => sessions.endOf({ sub: revoked.personId }));
  const opens = openedBy(open);
  const principalFor = (user: Pick<UserMetadata, 'id' | 'roles'>): Principal => principalOf(user, { role, instanceOwnerId });
  const getCookie = (req: express.Request, name: string) => parseCookie(req.headers.cookie, name);

  const sessionCookieOptions = {
    httpOnly: true,
    secure: publicUrl.startsWith('https://'),
    sameSite: 'lax' as const,
  };
  const securedFor = (arrived: { headers: IncomingHttpHeaders; secure: boolean }): boolean =>
    signsInThroughRoot(role) ? arrivedOverHttps(arrived.headers['x-forwarded-proto'], arrived.secure) : sessionCookieOptions.secure;

  const personHeld = async (req: HeldRequest): Promise<BrowserPerson | undefined> => {
    const held = req.session?.person;
    if (!throughRoot || !held) return undefined;
    const fresh = await throughRoot.signIn.fresh(held);
    if (fresh === 'ended') {
      await throughRoot.sessions.end(req as express.Request);
      return undefined;
    }
    if (fresh === 'kept') return held;
    if (fresh !== held) await throughRoot.sessions.keep(req as express.Request, fresh);
    return fresh;
  };

  const accountHeld = async (req: HeldRequest): Promise<{ user: UserMetadata; sessionId: string; sessionAt: number } | undefined> => {
    const held = own ? req.session?.account : undefined;
    if (!held) return undefined;
    const user = await db.accounts.getUserById(held.sub);
    return !user || user.removal ? undefined : { user, sessionId: req.sessionID, sessionAt: held.sessionAt };
  };

  async function sessionOf(req: IncomingMessage): Promise<{ user: UserMetadata; sessionId: string; sessionAt: number } | undefined> {
    if (!throughRoot) return accountHeld(req as HeldRequest);
    const person = await personHeld(req as HeldRequest);
    return person ? { user: userOfPerson(person), sessionId: (req as HeldRequest).sessionID, sessionAt: person.sessionAt } : undefined;
  }

  async function userOf(req: express.Request): Promise<UserMetadata | undefined> {
    await ran(sessions.handle, req, req.res!);
    return (await sessionOf(req))?.user;
  }

  async function holdAccount(req: express.Request, user: Pick<UserMetadata, 'id'>): Promise<void> {
    if (!own) throw new Error(`a ${role} signs people in only through root, so it holds no account's session of its own`);
    await ran(sessions.handle, req, req.res!);
    await own.sessions.holdAccount(req, { sub: user.id, sessionAt: Date.now() });
  }

  async function endSession(req: express.Request): Promise<string | undefined> {
    await ran(sessions.handle, req, req.res!);
    if (throughRoot) {
      const person = req.session?.person;
      if (!person) return undefined;
      await throughRoot.sessions.end(req);
      return throughRoot.signIn.end(person);
    }
    if (req.session?.account) await sessions.end(req);
    return undefined;
  }

  const requireAuth: express.RequestHandler = async (req, res, next) => {
    if (await opens(req, res)) return next();
    await ran(sessions.handle, req, res);
    const presented = bearer ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] : undefined;
    if (bearer && presented) {
      const signed = await bearer(presented);
      if ('refused' in signed) return res.status(401).json({ error: `Unauthorized: ${signed.refused}` });
      signedIn(req, { user: signed.user, principal: signed.principal });
      return next();
    }
    if (throughRoot) {
      if (!req.session?.person) return res.status(401).json({ error: 'Unauthorized: Session missing' });
      const person = await personHeld(req);
      if (!person) return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
      signedIn(req, { user: userOfPerson(person), sessionId: req.sessionID, principal: { kind: 'person', id: person.sub, claims: person.claims } });
      return next();
    }
    if (!req.session?.account) return res.status(401).json({ error: 'Unauthorized: Session missing' });
    const held = await accountHeld(req);
    if (!held) return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
    signedIn(req, { user: held.user, sessionId: held.sessionId, principal: principalFor(held.user) });
    next();
  };

  const requireOperator = (action: Actions['install']): express.RequestHandler => (req, res, next) => {
    const principal = (req as { principal?: Principal }).principal;
    const decision = principal ? authorize(principal, action, { kind: 'install' }) : undefined;
    if (!decision?.allowed) return res.status(403).json({ error: decision && !decision.allowed ? decision.error : 'Sign in first' });
    next();
  };

  const clearSession = (res: express.Response) => {
    res.clearCookie(cookieNamed(BROWSER_SESSION_COOKIE, true), { ...sessionCookieOptions, secure: true, path: '/' });
    res.clearCookie(cookieNamed(BROWSER_SESSION_COOKIE, false), { ...sessionCookieOptions, secure: false, path: '/' });
  };

  const inviteRefusal = (invite: InviteMetadata | undefined, email: string | undefined): string | null => {
    if (!invite) return 'Invalid invite code';
    if (invite.usedBy) return 'This invite code has already been used';
    if (inviteExpired(invite, new Date())) return 'This invite has expired; ask whoever sent it for a new one';
    if (invite.email && (!email || invite.email.trim().toLowerCase() !== email.trim().toLowerCase())) return `This invite is for ${invite.email}; sign up with that address`;
    return null;
  };

  async function inviteProblem(code: string | undefined, isFirstUser: boolean, email: string): Promise<string | null> {
    if (isFirstUser) return setupCodeProblem(setupCode, code) ?? null;
    if (!code) return 'An invite code is required to create an account';
    return inviteRefusal(await db.accounts.getInviteByCode(code), email);
  }

  async function claimHeldInvite(codeHash: string, newUserId: string, email: string): Promise<string | null> {
    const refused = inviteRefusal(await db.accounts.getInviteByHash(codeHash), email);
    if (refused) return refused;
    return await db.accounts.claimInviteByHash(codeHash, newUserId, new Date().toISOString()) ? null : 'This invite code has already been used';
  }

  async function checkAndConsumeInvite(code: string | undefined, newUserId: string, isFirstUser: boolean, email?: string): Promise<string | null> {
    if (isFirstUser) {
      const refused = setupCodeProblem(setupCode, code);
      if (refused) return refused;
      return await db.accounts.claimFirstAdmin(newUserId, new Date().toISOString()) ? null : 'Someone has just become the first account here; ask them for an invite';
    }
    if (!code) return 'An invite code is required to create an account';
    return claimHeldInvite(inviteCodeHash(code), newUserId, email ?? '');
  }

  return {
    getCookie, userOf, sessionOf, sessionHandle: sessions.handle, securedFor, requireAuth, requireOperator, principalFor,
    holdAccount, clearSession, endSession, sessionCookieOptions, checkAndConsumeInvite, inviteProblem, claimHeldInvite,
  };
}
