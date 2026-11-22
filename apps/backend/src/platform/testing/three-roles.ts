import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { leaseMongo } from '../lib/mongo-lease.js';
import { ignore } from '@koala/engine-core/failures';
import { expect, inject } from 'vitest';
import { waiting, waitUntil, type Found, type Waiting } from '@koala/provision';
import { roleFromEnv } from '../lib/platform-role.js';
import { testIdentityKey, testKeyEnv } from './keys.js';
import { createDatabase } from '../lib/db-interface.js';
import { databaseSettingsFrom } from '../lib/settings.js';
import { devSplitPlan, type SplitPlace } from '../../instances/lib/dev-split.js';
import { publicKeyPem } from '../../instances/lib/identity-token.js';
import { instanceIdFor } from '../../instances/services/InstanceService.js';
import { registrationCodeAt } from '../../instances/testing/registration-code.js';
import { generateIdentityKey } from '../../instances/lib/identity-token.js';
import { freshNamespace } from '../../workflows/testing/temporal-test-env.js';
import { fetchSide, handOff, sessionFrom, signedInLanding } from './handoff.js';
import { startRole, type LoopbackRole } from './roles-on-loopback.js';
import { smtpSink, type SmtpSink } from './smtp-sink.js';
import { startRealGitea } from '../../projects/testing/real-gitea.js';
import { startHeadscaleStandIn, type HeadscaleStandIn } from '../../infrastructure/testing/headscale-stand-in.js';
import { startDependencySourcesStandIn } from './dependency-sources-stand-in.js';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { TEST_RELEASE } from './platform-services.js';
import { interactionAt } from '../../accounts/testing/interaction-driver.js';
import { signInWithPassword } from '../../accounts/services/sign-in/password-at-root.js';

export interface TestGitea { url: string; adminPassword: string; logs(): string; close(): Promise<void> }

export interface Person { id: string; email: string; password: string; cookie: string }

export interface ThreeRoles {
  root: LoopbackRole;
  instance: LoopbackRole;
  mail: SmtpSink;
  owner: Person;
  operator: Person;
  gitea: TestGitea | undefined;
  headscale: HeadscaleStandIn | undefined;
  workers: Record<string, LoopbackRole>;
  instanceId: string;
  databases: { root: string; instance: string };
  mongoUri: string;
  keys: Record<string, string>;
  ownerOnInstance(): Promise<string>;
  signUp(email: string, inviteCode: string): Promise<Person>;
  close(): Promise<void>;
}

export interface ThreeRolesOptions {
  rootEnv?: ((rootUrl: string) => Promise<Record<string, string>>) | undefined;
  extra?: Record<string, string> | undefined;
  gitea?: boolean | undefined;
  ownerInvited?: boolean | undefined;
  rootWorkers?: readonly WorkerName[] | undefined;
  instanceWorkers?: readonly WorkerName[] | undefined;
}

export type WorkerName = 'host' | 'engine' | 'cluster';

async function signUpWith(rootUrl: string, mail: SmtpSink, email: string, inviteCode: string): Promise<Person> {
  const password = randomBytes(18).toString('base64url');
  const post = (path: string, body: unknown) => fetch(`${rootUrl}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const asked = await post('/auth/register', { email, password, inviteCode });
  const said = await asked.json() as { verify?: string; user?: { id: string }; error?: string };
  if (!asked.ok) throw new Error(`${email} could not sign up on root: ${asked.status} ${JSON.stringify(said)}`);
  if (said.verify) {
    const sent = await until(`the sign-up code mail to ${email}`, async () => mail.received.find((message) => message.to.includes(email) && /sign-up code/i.test(mail.subjectOf(message) ?? '')) ?? waiting(`${mail.received.length} mails received, subjects: ${mail.received.map((message) => mail.subjectOf(message)).join(' | ').slice(0, 200)}`));
    const code = /\b(\d{6})\b/.exec(sent.data)?.[1];
    const interaction = await interactionAt(rootUrl);
    const verified = await interaction.signUp(said.verify, code);
    const confirmed = await verified.json() as { next?: string; error?: string };
    if (!verified.ok || !confirmed.next) throw new Error(`${email} could not confirm the sign-up: ${verified.status} ${JSON.stringify(confirmed)}`);
    return personOn(rootUrl, email, password, (await interaction.followed(confirmed.next)).cookie);
  }
  return personOn(rootUrl, email, password, (await signInWithPassword(rootUrl, { email, password })).cookie);
}

async function personOn(rootUrl: string, email: string, password: string, cookie: string): Promise<Person> {
  const me = await fetch(`${rootUrl}/api/auth/me`, { headers: { cookie } });
  if (!me.ok) throw new Error(`${email} signed in on root, but root does not know the session: ${me.status} ${await me.text()}`);
  return { id: ((await me.json()) as { id: string }).id, email, password, cookie };
}

const WORKER_ENTRY: Record<WorkerName, string> = { host: 'src/worker-host.ts', engine: 'src/worker-engine.ts', cluster: 'src/worker-cluster.ts' };

async function workerEnv(): Promise<Record<string, string>> {
  return { TEMPORAL_METRICS_PORT: String(await portToHandOn()), TEMPORAL_ENGINE_METRICS_PORT: String(await portToHandOn()) };
}

export { waiting };

export const SAY_EVERY_LOOKS = 120;

export async function until<T extends Found>(what: string, look: () => Promise<T | Waiting>): Promise<T> {
  return waitUntil(what, async () => {
    try {
      return await look();
    } catch (err) {
      return waiting(`it does not answer yet: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, undefined, {
    pause: () => new Promise((done) => setTimeout(done, 250)),
    sayEvery: SAY_EVERY_LOOKS,
    waiting: (waited, last) => { console.log(`    still waiting for ${waited}${last ? ` (${last})` : ''}`); },
  });
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
  const clientKey = generateIdentityKey();
  const databases = { root: `${stamp}_root`, instance: `${stamp}_instance` };
  const mongoUri = inject('mongoUri');
  const mail = await smtpSink();
  const temporalNamespace = await freshNamespace();
  const ports = { root: await portToHandOn(), instance: await portToHandOn() };
  const place: SplitPlace = {
    rootUrl: `http://localhost:${ports.root}`, instanceUrl: `http://localhost:${ports.instance}`,
    rootApiPort: ports.root, instanceApiPort: ports.instance,
    rootDatabase: databases.root, instanceDatabase: databases.instance,
  };
  const identityKey = testIdentityKey();
  const signing = roleFromEnv({ ROOT_IDENTITY_KEY: identityKey, ROLE: 'root' }).signing!;
  const rootPublicKeys = publicKeyPem(signing.publicKey);
  const draft = (person: { id: string; email: string }, registrationCode: string) => devSplitPlan({
    name: label.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'three', owner: { id: person.id, email: person.email, twoFactorEnabled: false, emailVerified: true, createdAt: new Date().toISOString() },
    instanceId: instanceIdFor(person.id), clientKey, registrationCode,
    rootPublicKeys,
    mongoUri: `${mongoUri}${databases.root}`, now: new Date().toISOString(), place,
    temporal: { address: inject('temporalTlsAddress'), namespace: temporalNamespace.namespace, ca: inject('temporalCa') }, release: TEST_RELEASE, dataDir: rootData,
  });
  const shared = {
    ...testKeyEnv(secret),
    ROOT_IDENTITY_KEY: identityKey,
    TEMPORAL_CONNECTION_ADDRESS: inject('temporalTlsAddress'),
    TEMPORAL_NAMESPACE: temporalNamespace.namespace,
    MAIL_SMTP_URL: mail.url,
    MAIL_FROM: `koala@${label}.test`,
    WATCH_UNREACHABLE_MINUTES: '0.1',
    CERTIFICATES: 'internal',
    ...(options.extra ?? {}),
  };
  const rootSide: LoopbackRole[] = [];
  const instanceSide: LoopbackRole[] = [];
  const gitea: TestGitea | undefined = options.gitea ? await startRealGitea() : undefined;
  const headscale = await startHeadscaleStandIn();
  const dependencySources = await startDependencySourcesStandIn();
  const close = async () => {
    for (const side of [instanceSide, rootSide]) {
      for (const role of [...side].reverse()) await role.close();
    }
    await mail.close();
    await gitea?.close();
    await headscale?.close();
    await dependencySources.close();
    await temporalNamespace.drop();
    await rm(rootData, { recursive: true, force: true });
    await rm(instanceData, { recursive: true, force: true });
    const { client, release } = await leaseMongo(mongoUri);
    for (const database of Object.values(databases)) await client.db(database).dropDatabase();
    await release();
  };
  const giteaFor = (url: string) => (gitea ? { GITEA_URL: gitea.url, GITEA_REACHES_KOALA_AT: url } : {});
  const rootData = await mkdtemp(join(tmpdir(), `koala-${label}-root-data-`));
  const instanceData = await mkdtemp(join(tmpdir(), `koala-${label}-instance-data-`));
  for (const folder of gitea ? [instanceData] : []) await writeFile(join(folder, '.gitea-admin-password'), gitea!.adminPassword, { mode: 0o600 });
  try {
    const rootEnv = {
      ...draft({ id: 'pending', email: 'pending@three.test' }, 'root-is-given-no-registration-code').rootEnv, ...shared, ADMIN_SETUP_CODE: setupCode, DATA_DIR: rootData, DEPENDENCY_SOURCES: dependencySources.url,
      ...(headscale ? { MESH_LOGIN_SERVER: headscale.url, HEADSCALE_URL: headscale.url, HEADSCALE_API_KEY: headscale.apiKey } : {}),
      ...(options.rootEnv ? await options.rootEnv(place.rootUrl) : {}),
    };
    const root = await startRole('root', rootEnv, ports.root);
    rootSide.push(root);
    const workers: Record<string, LoopbackRole> = {};
    for (const name of options.rootWorkers ?? []) {
      const worker = await startRole(`root-${name}`, { ...rootEnv, ...await workerEnv() }, undefined, { entry: WORKER_ENTRY[name] });
      rootSide.push(worker);
      workers[`root-${name}`] = worker;
    }
    const emailOf = (who: string) => `${who}-${stamp}@three.test`.replace(/_/g, '-');
    const operator = await signUpWith(root.url, mail, emailOf(options.ownerInvited ? 'operator' : 'owner'), setupCode);
    const ownerInvite = async () => {
      const made = await fetch(`${root.url}/api/admin/invites`, { method: 'POST', headers: { 'content-type': 'application/json', Cookie: operator.cookie }, body: '{}' });
      if (!made.ok) throw new Error(`the operator could not make an invite: ${made.status} ${await made.text()}`);
      return ((await made.json()) as { code: string }).code;
    };
    const owner = options.ownerInvited ? await signUpWith(root.url, mail, emailOf('owner'), await ownerInvite()) : operator;
    const cookie = owner.cookie;
    const rootDb = createDatabase(databaseSettingsFrom({ ...testKeyEnv(secret), MONGO_URI: `${mongoUri}${databases.root}` }));
    await rootDb.init();
    const plan = draft(owner, await registrationCodeAt({ db: rootDb, url: root.url, signing }, { id: instanceIdFor(owner.id), ownerId: owner.id }));
    await rootDb.instances.saveInstance(plan.instance);
    await rootDb.close?.();
    const gatewayPort = await portToHandOn();
    const temporalTls = dirname(inject('temporalCa'));
    const machineGateway = { MACHINE_GATEWAY_PORT: String(gatewayPort), MACHINE_TEMPORAL_ADDRESS: `127.0.0.1:${gatewayPort}`, MACHINE_GATEWAY_TLS_CERT: join(temporalTls, 'server.crt'), MACHINE_GATEWAY_TLS_KEY: join(temporalTls, 'server.key') };
    const instanceEnv = { ...plan.instanceEnv, ...shared, ...machineGateway, DATA_DIR: instanceData, MONGO_URI: `${mongoUri}${databases.instance}`, CHECKS_API_URL: `${place.instanceUrl}/api`, ...giteaFor(place.instanceUrl) };
    const instance = await startRole('instance', instanceEnv, ports.instance);
    instanceSide.push(instance);
    for (const name of options.instanceWorkers ?? []) {
      const worker = await startRole(`instance-${name}`, { ...instanceEnv, ...await workerEnv(), POD_NAME: `instance-${name}` }, undefined, { entry: WORKER_ENTRY[name] });
      instanceSide.push(worker);
      workers[`instance-${name}`] = worker;
    }
    const goes = async (query: string, to: string) => {
      const answer = await fetch(`${root.url}/api/identity/go${query}`, { redirect: 'manual', headers: { Cookie: cookie } });
      const location = answer.headers.get('location');
      return location === to ? true : waiting(`root answered ${answer.status} with location ${location}`);
    };
    await until('root to send the owner on to the instance', () => goes('', `${instance.url}/api/auth/oidc/start`));
    return {
      root, instance, mail, owner, operator, gitea, headscale, workers, instanceId: plan.instance.id, databases, mongoUri, keys: testKeyEnv(secret),
      ownerOnInstance: () => signedIn(root.url, cookie, instance.url, '/api/identity/go'),
      signUp: (email, inviteCode) => signUpWith(root.url, mail, email, inviteCode),
      close,
    };
  } catch (err) {
    await close().catch(ignore('the start already failed, and that failure is the one thrown'));
    throw err;
  }
}

export interface Answer<T> { status: number; location: string; body: T }

export async function call<T = Record<string, unknown>>(url: string, init: { method?: string; body?: unknown; cookie?: string | undefined; headers?: Record<string, string> } = {}): Promise<Answer<T>> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}), ...(init.headers ?? {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch (failure) {
    ignore('an answer that is not JSON is kept as its text')(failure);
  }
  return { status: response.status, location: response.headers.get('location') ?? '', body: body as T };
}

async function accountGoneFromRoot(roles: ThreeRoles, id: string): Promise<boolean> {
  const db = createDatabase(databaseSettingsFrom({ ...roles.keys, MONGO_URI: `${roles.mongoUri}${roles.databases.root}` }));
  await db.init();
  try {
    return (await db.accounts.getUserById(id)) === undefined;
  } finally {
    await db.close?.();
  }
}

export async function removeAccountOnRoot(roles: ThreeRoles, who: Person): Promise<void> {
  const removed = await call(`${roles.root.url}/api/account`, { method: 'DELETE', body: { confirm: who.email, password: who.password }, cookie: who.cookie });
  expect(removed.status, JSON.stringify(removed.body)).toBe(202);
  await until(`root to remove the account of ${who.email}`, async () => ((await accountGoneFromRoot(roles, who.id)) ? true : waiting('the account is still on root')));
}
