import express from 'express';
import { parseCookie as cookiesIn } from 'cookie';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { arrivedOverHttps, cookieNamed } from '../lib/auth.js';
import { BROWSER_SESSION_COOKIE, type BrowserPerson, type PersonThroughRoot } from '../lib/browser-session.js';
import type { BrowserSessions } from '../services/BrowserSessions.js';
import type { AccessRevocations } from '../services/AccessRevocations.js';
import type { KeptSession } from '../lib/revocations.js';
import { inviteCodeHash, inviteExpired } from '../lib/invite-codes.js';
import { setupCodeProblem } from '../lib/first-admin.js';
import type { Database } from '../lib/db-interface.js';
import type { InviteMetadata, UserMetadata } from '../lib/types.js';
import { signsInThroughRoot, type PlatformRole } from '../lib/platform-role.js';
import { asyncRoute } from './async-route.js';
import { authorize, principalOf, type Actions, type BearerSignIn, type Principal, type Resource } from '../lib/permissions.js';

export interface ThroughRoot {
  sessions: BrowserSessions;
  signIn: PersonThroughRoot;
}

export const parseCookie = (cookieHeader: string | undefined, name: string): string | undefined =>
  cookieHeader ? cookiesIn(cookieHeader)[name] : undefined;

export interface AuthDeps {
  db: Database;
  publicUrl: string;
  role: PlatformRole;
  instanceOwnerId?: string | undefined;
  setupCode?: string | undefined;
  throughRoot: ThroughRoot;
  bearer?: ((token: string) => Promise<BearerSignIn>) | undefined;
  revocations?: Pick<AccessRevocations, 'listen'> | undefined;
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
  keptSession: (req: express.Request) => KeptSession;
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

export function createAuth({ db, publicUrl, role, instanceOwnerId, setupCode, throughRoot, bearer, revocations, open }: AuthDeps): Auth {
  if (signsInThroughRoot(role) && revocations) throw new Error(`a ${role} hears revocations from root's back-channel, so it is given none to listen to`);
  if (!signsInThroughRoot(role) && !revocations) throw new Error(`a ${role} ends its own browser sessions when a person's access is revoked, so it is given the revocations to listen to`);
  const { sessions } = throughRoot;
  revocations?.listen(async (revoked) => sessions.endOf({ sub: revoked.personId, except: revoked.kept?.session }));
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
    if (!held) return undefined;
    const fresh = await throughRoot.signIn.fresh(held);
    if (fresh === 'ended') {
      await sessions.end(req as express.Request);
      return undefined;
    }
    if (fresh === 'kept') return held;
    if (fresh !== held) await sessions.keep(req as express.Request, fresh);
    return fresh;
  };

  const accountOf = async (person: BrowserPerson): Promise<UserMetadata | undefined> => {
    if (signsInThroughRoot(role)) return userOfPerson(person);
    const user = await db.accounts.getUserById(person.sub);
    return !user || user.removal ? undefined : user;
  };

  const principalOfPerson = (person: BrowserPerson, user: UserMetadata): Principal =>
    signsInThroughRoot(role) ? { kind: 'person', id: person.sub, claims: person.claims } : principalFor(user);

  async function signedInBy(req: HeldRequest): Promise<{ person: BrowserPerson; user: UserMetadata } | undefined> {
    const person = await personHeld(req);
    const user = person ? await accountOf(person) : undefined;
    return person && user ? { person, user } : undefined;
  }

  async function sessionOf(req: IncomingMessage): Promise<{ user: UserMetadata; sessionId: string; sessionAt: number } | undefined> {
    const held = await signedInBy(req as HeldRequest);
    return held ? { user: held.user, sessionId: (req as HeldRequest).sessionID, sessionAt: held.person.sessionAt } : undefined;
  }

  async function userOf(req: express.Request): Promise<UserMetadata | undefined> {
    await ran(sessions.handle, req, req.res!);
    return (await sessionOf(req))?.user;
  }

  const keptSession = (req: express.Request): KeptSession => {
    const rootSid = req.session?.person?.rootSid;
    if (!rootSid) throw new Error(`${req.method} ${req.path} kept a browser signed in that root named no session for`);
    return { session: req.sessionID, rootSid };
  };

  async function endSession(req: express.Request): Promise<string | undefined> {
    await ran(sessions.handle, req, req.res!);
    const person = req.session?.person;
    if (!person) return undefined;
    await sessions.end(req);
    return throughRoot.signIn.end(person);
  }

  const requireAuth: express.RequestHandler = asyncRoute(async (req, res, next) => {
    if (await opens(req, res)) return next();
    await ran(sessions.handle, req, res);
    const presented = bearer ? /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] : undefined;
    if (bearer && presented) {
      const signed = await bearer(presented);
      if ('refused' in signed) return res.status(401).json({ error: `Unauthorized: ${signed.refused}` });
      signedIn(req, { user: signed.user, principal: signed.principal });
      return next();
    }
    if (!req.session?.person) return res.status(401).json({ error: 'Unauthorized: Session missing' });
    const held = await signedInBy(req);
    if (!held) return res.status(401).json({ error: 'Unauthorized: Session invalid or expired' });
    signedIn(req, { user: held.user, sessionId: req.sessionID, principal: principalOfPerson(held.person, held.user) });
    next();
  });

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
    keptSession, clearSession, endSession, sessionCookieOptions, checkAndConsumeInvite, inviteProblem, claimHeldInvite,
  };
}
