import type express from 'express';
import type { Database } from '../../platform/index.js';
import { createAuth, type Auth } from '../../platform/middleware/auth.js';
import { browserSessionsFor, type BrowserSessions } from '../../platform/services/BrowserSessions.js';
import { signedInWithPassword } from '../../accounts/testing/password-sign-in.js';
import type { DependencyId } from '../../platform/lib/dependencies.js';
import type { AccessRevocations } from '../../platform/services/AccessRevocations.js';
import { rootAuthOver } from '../../platform/testing/root-auth.js';
import { generateIdentityKey, identityKeysFrom, publicKeyPem, trustedKeys, type IdentityKeyPair } from '../lib/identity-token.js';
import type { RootProvider } from '../services/RootProvider.js';
import type { InstanceReach } from '../services/InstanceReach.js';
import { RootSignIn } from '../services/RootSignIn.js';
import { RunBearers } from '../services/RunBearers.js';
import { InstanceService } from '../services/InstanceService.js';
import { signInRouter } from '../routes/sign-in.js';
import { IdentityService } from '../services/IdentityService.js';
import { openRoutesOf } from '../../open-routes.js';

export const rootSigning = identityKeysFrom(generateIdentityKey());
const INSTANCE_SESSION ='instance-session-key-for-the-round-trip';
const DATA_KEY = 'instance-data-key-for-the-round-trip-0001';

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
  clientKeys: IdentityKeyPair;
  registrationCode: string;
  rootAuth: Auth;
  rootRevocations: AccessRevocations;
  signInAtRoot(person: { id: string; email: string }): Promise<Jar>;
}

export async function servedThroughRoot(options: ThroughRootOptions): Promise<ThroughRoot> {
  const { rootDb, instanceDb, root, instance, instanceId, ownerId } = options;
  await rootDb.instances.saveInstance({ id: instanceId, ownerId, url: instance.url, createdAt: 'x', updatedAt: 'x', status: 'ready' });

  const world = rootAuthOver(rootDb, { publicUrl: root.url, open: openRoutesOf('root'), signing: rootSigning, instanceReach: options.reach });
  const { provider, auth: rootAuth, revocations: rootRevocations } = world;
  const rootService = new InstanceService(rootDb, { rootUrl: root.url, rootPublicKeys: () => [], registry: '', imageTag: 'dev', serviceCaller: (token) => provider.serviceCaller(token), registrationCode: (placed) => provider.registrationCode(placed) }, undefined);
  world.mount(root.app);
  const signInAtRoot = async (person: { id: string; email: string }): Promise<Jar> => (await signedInWithPassword(root.url, rootDb.accounts, person.id)).jar;
  const registrationCode = await provider.registrationCode({ id: instanceId, ownerId });
  const clientKeys = identityKeysFrom(generateIdentityKey());

  const sessions = browserSessionsFor('instance', instance.url, { store: instanceDb.platform, secret: INSTANCE_SESSION });
  const signIn = new RootSignIn({
    kind: 'instance',
    clientId: instanceId,
    rootUrl: root.url,
    publicUrl: instance.url,
    owner: ownerId,
    clientKeys,
    registrationCode,
    dataKey: DATA_KEY,
  }, { store: instanceDb, sessions, revocations: options.revocations, dependency: options.dependency }, options.now);
  const bearers = new RunBearers({ tokens: signIn, grantOfRun: (runId) => instanceDb.engine.getRunGrantOfRun(runId), accounts: instanceDb.accounts, claims: { role: 'instance', instanceOwnerId: ownerId } });
  const instanceAuth = createAuth({ db: instanceDb, publicUrl: instance.url, role: 'instance', open: openRoutesOf('instance'), instanceOwnerId: ownerId, throughRoot: { sessions, signIn }, bearer: (token) => bearers.signIn(token) });
  const identity = new IdentityService({ role: 'instance', trusted: trustedKeys([publicKeyPem(rootSigning.publicKey)]), instance: { id: instanceId, ownerId, rootUrl: root.url } }, instanceDb);
  instance.app.use('/api/auth', signInRouter({ signIn, sessions, identity, publicUrl: instance.url, landing: '/chat' }));

  return { provider, rootService, sessions, signIn, instanceAuth, clientKeys, registrationCode, rootAuth, rootRevocations, signInAtRoot };
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
