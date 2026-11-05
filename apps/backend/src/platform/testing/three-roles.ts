import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { ignore } from '@koala/engine-core/failures';
import { inject } from 'vitest';
import { roleFromEnv } from '../lib/platform-role.js';
import { createDatabase } from '../lib/db-interface.js';
import { devSplitPlan, type SplitPlace } from '../../instances/lib/dev-split.js';
import { publicKeyPem } from '../../instances/lib/identity-token.js';
import { hashCredential, instanceIdFor } from '../../instances/services/InstanceService.js';
import { claimNamespaceFor } from '../../workflows/temporal-test-env.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './handoff.js';
import { freePort, startRole, type LoopbackRole } from './roles-on-loopback.js';
import { smtpSink, type SmtpSink } from './smtp-sink.js';

export interface ThreeRoles {
  root: LoopbackRole;
  instance: LoopbackRole;
  hub: LoopbackRole;
  mail: SmtpSink;
  owner: { id: string; email: string; cookie: string };
  instanceId: string;
  instanceCredential: string;
  databases: { root: string; instance: string; hub: string };
  mongoUri: string;
  ownerOnInstance(): Promise<string>;
  ownerOnHub(): Promise<string>;
  close(): Promise<void>;
}

export interface ThreeRolesOptions {
  rootEnv?: ((rootUrl: string) => Promise<Record<string, string>>) | undefined;
  extra?: Record<string, string> | undefined;
}

export async function until<T>(look: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look().catch(ignore('what is waited for may not answer yet, which is what waiting looks like; the loop asks again'));
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 250));
  }
}

async function signedIn(from: string, cookie: string, target: string, first: string): Promise<string> {
  const handed = await handOff(fetchSide(from, cookie), fetchSide(target), first);
  const session = sessionFrom(handed.exchange.setCookies);
  if (!signedInLanding(handed.exchange) || !session) throw new Error(`${target} did not sign its owner in: ${handed.exchange.status} ${handed.exchange.body.slice(0, 300)}`);
  return session;
}

export async function startThreeRoles(label: string, options: ThreeRolesOptions = {}): Promise<ThreeRoles> {
  const stamp = `${label}_${Date.now().toString(36)}`;
  const secret = `three-roles-${stamp}`;
  const setupCode = randomBytes(12).toString('base64url');
  const instanceCredential = randomBytes(32).toString('base64url');
  const hubCredential = randomBytes(32).toString('base64url');
  const databases = { root: `${stamp}_root`, instance: `${stamp}_instance`, hub: `${stamp}_hub` };
  const mongoUri = inject('mongoUri');
  const mail = await smtpSink();
  const ports = { root: await freePort(), instance: await freePort(), hub: await freePort() };
  const place: SplitPlace = {
    rootUrl: `http://localhost:${ports.root}`, instanceUrl: `http://localhost:${ports.instance}`, hubUrl: `http://localhost:${ports.hub}`,
    rootApiPort: ports.root, instanceApiPort: ports.instance, hubApiPort: ports.hub,
    rootDatabase: databases.root, hubDatabase: databases.hub, instanceDatabase: databases.instance,
  };
  const signing = roleFromEnv({ JWT_SECRET: secret, ROLE: 'root' }).signing!;
  const draft = (person: { id: string; email: string }) => devSplitPlan({
    name: label.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'three', owner: { id: person.id, email: person.email, twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() },
    instanceId: instanceIdFor(person.id), credential: instanceCredential, credentialHash: hashCredential(instanceCredential),
    hubCredential, hubCredentialHash: hashCredential(hubCredential), rootPublicKeys: publicKeyPem(signing.publicKey),
    mongoUri: `${mongoUri}${databases.root}`, now: new Date().toISOString(), place,
  });
  const shared = {
    JWT_SECRET: secret,
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalAddress'),
    TEMPORAL_NAMESPACE: claimNamespaceFor(inject('temporalClaims')),
    MAIL_SMTP_URL: mail.url,
    MAIL_FROM: `koala@${label}.test`,
    WATCH_UNREACHABLE_MINUTES: '1',
    CERTIFICATES: 'internal',
    ...(options.extra ?? {}),
  };
  const started: LoopbackRole[] = [];
  const close = async () => {
    await Promise.all(started.map((role) => role.close()));
    await mail.close();
    const client = new MongoClient(mongoUri);
    await client.connect();
    for (const database of Object.values(databases)) await client.db(database).dropDatabase();
    await client.close();
  };
  try {
    const root = await startRole('root', {
      ...draft({ id: 'pending', email: 'pending@three.test' }).rootEnv, ...shared, ADMIN_SETUP_CODE: setupCode,
      ...(options.rootEnv ? await options.rootEnv(place.rootUrl) : {}),
    }, ports.root);
    started.push(root);
    const email = `owner-${stamp}@three.test`.replace(/_/g, '-');
    const password = randomBytes(18).toString('base64url');
    const post = (path: string, body: unknown) => fetch(`${root.url}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const made = await post('/auth/register', { email, password, inviteCode: setupCode });
    if (!made.ok) throw new Error(`the owner could not sign up on root: ${made.status} ${await made.text()}`);
    const login = await post('/auth/login', { email, password });
    const cookie = login.headers.getSetCookie().map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=/.test(pair));
    if (!cookie) throw new Error('signing in on root set no session cookie');
    const owner = { id: ((await login.json()) as { user: { id: string } }).user.id, email, cookie };
    const plan = draft(owner);
    const rootDb = createDatabase({ ...process.env, MONGO_URI: `${mongoUri}${databases.root}` });
    await rootDb.init();
    await rootDb.instances.saveInstance(plan.instance);
    await rootDb.close?.();
    const [instance, hub] = await Promise.all([
      startRole('instance', { ...plan.instanceEnv, ...shared, MONGO_URI: `${mongoUri}${databases.instance}` }, ports.instance),
      startRole('hub', { ...plan.hubEnv, ...shared }, ports.hub),
    ]);
    started.push(instance, hub);
    const goes = async (query: string, to: string) => {
      const answer = await fetch(`${root.url}/api/identity/go${query}`, { redirect: 'manual', headers: { Cookie: cookie } });
      return answer.headers.get('location') === to ? true : undefined;
    };
    await until(() => goes('?to=hub', `${hub.url}/api/auth/oidc/start`));
    await until(() => goes('', `${instance.url}/api/auth/oidc/start`));
    return {
      root, instance, hub, mail, owner, instanceId: plan.instance.id, instanceCredential, databases, mongoUri,
      ownerOnInstance: () => signedIn(root.url, cookie, instance.url, '/api/identity/go'),
      ownerOnHub: () => signedIn(root.url, cookie, hub.url, '/api/identity/go?to=hub'),
      close,
    };
  } catch (err) {
    await close().catch(ignore('the start already failed, and that failure is the one thrown'));
    throw err;
  }
}
