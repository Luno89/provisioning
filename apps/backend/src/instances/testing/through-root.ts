import express from 'express';
import { asyncRoute, type Database } from '../../platform/index.js';
import { createAuth, type Auth } from '../../platform/middleware/auth.js';
import { SessionEnds } from '../../platform/services/SessionEnds.js';
import { BrowserSessions } from '../../platform/services/BrowserSessions.js';
import { arrivedOverHttps, sessionToken } from '../../platform/lib/auth.js';
import type { DependencyId } from '../../platform/lib/dependencies.js';
import type { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys } from '../lib/identity-token.js';
import { clientKeysFrom } from '../lib/oidc.js';
import { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import { RootSignIn } from '../services/RootSignIn.js';
import { RunBearers } from '../services/RunBearers.js';
import { InstanceService, hashCredential } from '../services/InstanceService.js';
import { oidcProviderRouter } from '../routes/oidc-provider.js';
import { signInRouter } from '../routes/sign-in.js';
import { IdentityService } from '../services/IdentityService.js';
import { openRoutesOf } from '../../open-routes.js';

export const rootSigning = identityKeysFrom(generateIdentityKey());
const ROOT_SESSION = 'root-session-key-for-the-round-trip';
const INSTANCE_SESSION = 'instance-session-key-for-the-round-trip';
const DATA_KEY = 'instance-data-key-for-the-round-trip-0001';
const PROVIDER_COOKIE_KEY = 'cookie-key-for-the-round-trip';
export const INSTANCE_CREDENTIAL = 'the-instance-credential';

export interface Served { url: string; app: express.Express }

export type Jar = Map<string, string>;

export const SESSION_ID_COOKIE = 'koala_sid';

export const remember = (jar: Jar, answer: Response): void => {
  for (const line of answer.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair!.indexOf('=');
    const name = pair!.slice(0, at);
    const value = pair!.slice(at + 1);
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
};

export const cookieOf = (jar: Jar): string => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

export const sessionIdOf = (jar: Jar): string | undefined => {
  const held = jar.get(SESSION_ID_COOKIE);
  return held ? /^s:([^.]+)\./.exec(decodeURIComponent(held))?.[1] : undefined;
};

export const rootSessionOf = (person: { id: string; email: string }): Jar => new Map([['session', sessionToken(person, ROOT_SESSION)]]);

export interface ThroughRootOptions {
  rootDb: Database;
  instanceDb: Database;
  root: Served;
  instance: Served;
  reach: InstanceReach;
  instanceId: string;
  ownerId: string;
  revocations: AccessRevocations;
  dependency: { failed(dependency: DependencyId, err: unknown): unknown };
  now?: () => number;
}

export interface ThroughRoot {
  provider: RootProvider;
  rootService: InstanceService;
  sessions: BrowserSessions;
  signIn: RootSignIn;
  instanceAuth: Auth;
}

export async function servedThroughRoot(options: ThroughRootOptions): Promise<ThroughRoot> {
  const { rootDb, instanceDb, root, instance, instanceId, ownerId } = options;
  await rootDb.instances.saveInstance({ id: instanceId, ownerId, url: instance.url, credentialHash: hashCredential(INSTANCE_CREDENTIAL), createdAt: 'x', updatedAt: 'x', status: 'ready' });

  const provider = new RootProvider({ issuer: `${root.url}/oidc`, signing: rootSigning, cookieKey: PROVIDER_COOKIE_KEY, proxied: false, reach: options.reach }, rootDb);
  const rootService = new InstanceService(rootDb, { rootUrl: root.url, rootPublicKeys: () => [], registry: '', imageTag: 'dev', serviceCaller: (token) => provider.serviceCaller(token) }, undefined);
  const rootAuth = createAuth({ db: rootDb, sessionKey: ROOT_SESSION, publicUrl: root.url, role: 'root', open: openRoutesOf('root'), sessionEnds: new SessionEnds(rootDb.platform) });
  root.app.use('/oidc', oidcProviderRouter({ provider, signedIn: (req) => rootAuth.userFromSessionCookie(req.headers.cookie, false) }));
  root.app.put('/api/instances/sign-in-key', express.json(), asyncRoute(async (req, res) => {
    const outcome = await rootService.announceSignIn(req.headers['x-instance-id'], String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''), ((req.body ?? {}) as { jwk?: unknown }).jwk);
    if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error });
    return res.json(outcome.value);
  }));

  const sessions = new BrowserSessions({ store: instanceDb.platform, secret: INSTANCE_SESSION, securedFor: (req) => arrivedOverHttps(req.headers['x-forwarded-proto'], false) });
  const signIn = new RootSignIn({
    kind: 'instance',
    clientId: instanceId,
    rootUrl: root.url,
    publicUrl: instance.url,
    owner: ownerId,
    clientKeys: clientKeysFrom(INSTANCE_SESSION),
    dataKey: DATA_KEY,
    announce: { path: '/api/instances/sign-in-key', headers: { 'x-instance-id': instanceId, authorization: `Bearer ${INSTANCE_CREDENTIAL}` } },
  }, { store: instanceDb, sessions, revocations: options.revocations, dependency: options.dependency }, options.now);
  const bearers = new RunBearers({ tokens: signIn, grantOfRun: (runId) => instanceDb.engine.getRunGrantOfRun(runId), accounts: instanceDb.accounts, claims: { role: 'instance', instanceOwnerId: ownerId } });
  const instanceAuth = createAuth({ db: instanceDb, sessionKey: INSTANCE_SESSION, publicUrl: instance.url, role: 'instance', open: openRoutesOf('instance'), instanceOwnerId: ownerId, throughRoot: { sessions, signIn }, bearer: (token) => bearers.signIn(token) });
  const identity = new IdentityService({ role: 'instance', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]), instance: { id: instanceId, ownerId, rootUrl: root.url } }, instanceDb);
  instance.app.use('/api/auth', signInRouter({ signIn, sessions, identity, publicUrl: instance.url, landing: '/chat' }));

  return { provider, rootService, sessions, signIn, instanceAuth };
}

export async function signInThroughRoot(rootUrl: string, at: string, rootJar: Jar): Promise<{ instanceJar: Jar; landed: Response }> {
  const instanceJar: Jar = new Map();
  const rootOrigin = new URL(rootUrl).origin;
  const atOrigin = new URL(at).origin;
  let answer = await fetch(`${at}/api/auth/oidc/start`, { redirect: 'manual' });
  remember(instanceJar, answer);
  for (;;) {
    const location = answer.headers.get('location');
    if (answer.status < 300 || answer.status >= 400 || !location || location.startsWith('/#')) return { instanceJar, landed: answer };
    const next = new URL(location, answer.url);
    if (next.origin !== rootOrigin && next.origin !== atOrigin) return { instanceJar, landed: answer };
    const jar = next.origin === rootOrigin ? rootJar : instanceJar;
    answer = await fetch(next, { redirect: 'manual', headers: { cookie: cookieOf(jar) } });
    remember(jar, answer);
  }
}
