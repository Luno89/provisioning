import express from 'express';
import { inject } from 'light-my-request';
import type { Database } from '../lib/db-interface.js';
import { createAuth, type AuthDeps, type Auth } from '../middleware/auth.js';
import { AccessRevocations } from '../services/AccessRevocations.js';
import { BrowserSessions } from '../services/BrowserSessions.js';

export interface RootAuthWorld {
  auth: Auth;
  sessions: BrowserSessions;
  revocations: AccessRevocations;
}

export function rootAuthOver(db: Database, deps: Pick<AuthDeps, 'open'> & Partial<Pick<AuthDeps, 'publicUrl' | 'setupCode' | 'bearer'>> & { revocations?: AccessRevocations | undefined }): RootAuthWorld {
  const publicUrl = deps.publicUrl ?? 'http://localhost:3001';
  const revocations = deps.revocations ?? new AccessRevocations();
  const sessions = new BrowserSessions({ store: db.platform, secret: 'root-sessions-under-test', securedFor: () => publicUrl.startsWith('https://') });
  const auth = createAuth({ db, publicUrl, role: 'root', open: deps.open, setupCode: deps.setupCode, bearer: deps.bearer, own: { sessions, revocations } });
  return { auth, sessions, revocations };
}

export async function accountHeldFor(auth: Pick<Auth, 'sessionHandle' | 'sessionOf'>, cookie: string | undefined): Promise<string | undefined> {
  if (!cookie) return undefined;
  const app = express();
  app.get('/', auth.sessionHandle, (req, res, next) => { auth.sessionOf(req).then((held) => res.json({ id: held?.user.id ?? null }), next); });
  const answer = await inject(app, { method: 'GET', url: '/', headers: { cookie } });
  if (answer.statusCode !== 200) throw new Error(`reading who a cookie holds answered ${answer.statusCode}: ${answer.body}`);
  return (JSON.parse(answer.body) as { id: string | null }).id ?? undefined;
}
