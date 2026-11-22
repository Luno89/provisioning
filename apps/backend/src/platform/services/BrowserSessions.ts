import type { IncomingMessage, ServerResponse } from 'node:http';
import type express from 'express';
import session from 'express-session';
import { arrivedOverHttps, cookieNamed } from '../lib/auth.js';
import { signsInThroughRoot, type PlatformRole } from '../lib/platform-role.js';
import { ringOf, type SecretKey } from '../lib/crypto.js';
import { BROWSER_SESSION_COOKIE, BROWSER_SESSION_SECONDS, type BrowserPerson, type BrowserSessionsOf } from '../lib/browser-session.js';
import type { PlatformStore } from '../store.js';

export interface BrowserSessionsDeps {
  store: Pick<PlatformStore, 'browserSessions' | 'endBrowserSessions'>;
  secret: SecretKey;
  securedFor: (arrived: IncomingMessage & { secure?: boolean }) => boolean;
}

type Handler = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

const settled = (act: (done: (err?: unknown) => void) => void): Promise<void> =>
  new Promise((resolve, reject) => { act((err) => (err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve())); });

export class BrowserSessions {
  private readonly over: { https: Handler; http: Handler };
  private readonly listeners: Array<(sid: string) => void> = [];

  constructor(private readonly deps: BrowserSessionsDeps) {
    const ring = ringOf(deps.secret);
    const made = (secure: boolean): Handler => session({
      name: cookieNamed(BROWSER_SESSION_COOKIE, secure),
      secret: [ring.current, ...(ring.previous ?? [])],
      store: Object.create(deps.store.browserSessions()) as session.Store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      proxy: secure,
      cookie: { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: BROWSER_SESSION_SECONDS * 1000 },
    }) as unknown as Handler;
    this.over = { https: made(true), http: made(false) };
  }

  readonly handle: Handler = (req, res, next) => {
    (this.deps.securedFor(req) ? this.over.https : this.over.http)(req, res, next);
  };

  onEnd(listener: (sid: string) => void): void {
    this.listeners.push(listener);
  }

  async hold(req: express.Request, person: BrowserPerson): Promise<void> {
    await settled((done) => req.session.regenerate(done));
    req.session.person = person;
    await settled((done) => req.session.save(done));
  }

  async keep(req: express.Request, person: BrowserPerson): Promise<void> {
    req.session.person = person;
    await settled((done) => req.session.save(done));
  }

  async end(req: express.Request): Promise<void> {
    const sid = req.sessionID;
    await settled((done) => req.session.destroy(done));
    this.ended([sid]);
  }

  async endOf(of: BrowserSessionsOf): Promise<string[]> {
    const ids = await this.deps.store.endBrowserSessions(of);
    this.ended(ids);
    return ids;
  }

  private ended(ids: readonly string[]): void {
    for (const sid of ids) for (const listener of this.listeners) listener(sid);
  }
}

export function browserSessionsFor(role: PlatformRole, publicUrl: string, deps: Omit<BrowserSessionsDeps, 'securedFor'>): BrowserSessions {
  return new BrowserSessions({
    ...deps,
    securedFor: signsInThroughRoot(role) ? (req) => arrivedOverHttps(req.headers['x-forwarded-proto'], req.secure === true) : () => publicUrl.startsWith('https://'),
  });
}
