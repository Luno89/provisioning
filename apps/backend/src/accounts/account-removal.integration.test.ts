import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client, Connection } from '@temporalio/client';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it, onTestFailed } from 'vitest';
import { ACCOUNT_DATA, removeAccountWorkflowId } from './lib/account-removal.js';
import { labelValue } from '../engine-host/sandboxes/workspace.js';
import { claimNamespaceFor } from '../workflows/temporal-test-env.js';
import { freePort, startRole, startWorker, type LoopbackProcess, type LoopbackRole } from '../platform/testing/roles-on-loopback.js';
import { smtpSink, textOf, type SmtpSink } from '../platform/testing/smtp-sink.js';
import { until } from '../platform/testing/three-roles.js';
import { buildDataConverter } from '@koala/engine-core/payloads';
import { loadKeys } from '../platform/lib/keys.js';

interface Answer { status: number; cookies: string[]; body: unknown }

async function call(url: string, init: { method?: string; body?: unknown; cookie?: string | undefined } = {}): Promise<Answer> {
  const response = await fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text) as unknown; } catch { body = text; }
  return { status: response.status, cookies: response.headers.getSetCookie(), body };
}

const sessionOf = (answer: Answer) => answer.cookies.map((line) => line.split(';')[0]!).find((pair) => /^(__Host-)?session=./.test(pair));

interface StandIn { url: string; asked: string[]; close(): Promise<void> }

async function standIn(answer: (path: URL) => unknown): Promise<StandIn> {
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    const at = new URL(req.url ?? '/', 'http://stand-in');
    asked.push(`${req.method} ${at.pathname}${at.search}`);
    const body = answer(at);
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
  };
}

const NAMESPACES = { kind: 'APIResourceList', groupVersion: 'v1', resources: [{ name: 'namespaces', singularName: 'namespace', namespaced: false, kind: 'Namespace', verbs: ['create', 'delete', 'get', 'list', 'watch'], shortNames: ['ns'] }] };

const kubeAnswer = (at: URL): unknown => {
  if (at.pathname === '/api') return { kind: 'APIVersions', versions: ['v1'], serverAddressByClientCIDRs: [] };
  if (at.pathname === '/apis') return { kind: 'APIGroupList', apiVersion: 'v1', groups: [] };
  if (at.pathname === '/api/v1') return NAMESPACES;
  if (at.pathname === '/api/v1/namespaces') return { kind: 'NamespaceList', apiVersion: 'v1', metadata: { resourceVersion: '1' }, items: [] };
  return undefined;
};

const headscaleAnswer = (at: URL): unknown => (at.pathname === '/api/v1/user' ? { users: [] } : undefined);

const STAMP = Date.now().toString(36);
const SECRET = `removal-${STAMP}`;
const DATABASE = `removal_${STAMP}`;
const SETUP_CODE = randomBytes(12).toString('base64url');
const QUEUE = `removal-engine-${STAMP}`;
const email = `removal-${STAMP}@removal.test`;
const password = randomBytes(18).toString('base64url');

let mail: SmtpSink;
let kube: StandIn;
let headscale: StandIn;
let backend: LoopbackRole;
let worker: LoopbackProcess;
let folder: string;
let mongo: MongoClient;
let adminCookie: string;
let personCookie: string;
let ownerId = '';
let namespace: string;
let temporalAddress: string;

const api = (path: string, init: { method?: string; body?: unknown; cookie?: string | undefined } = {}) => call(`${backend.url}/api${path}`, init);

beforeAll(async () => {
  const mongoUri = inject('mongoUri');
  temporalAddress = inject('temporalAddress');
  namespace = claimNamespaceFor(inject('temporalClaims'));
  mail = await smtpSink();
  kube = await standIn(kubeAnswer);
  headscale = await standIn(headscaleAnswer);
  folder = await mkdtemp(join(tmpdir(), 'koala-removal-'));
  const kubeconfig = join(folder, 'kubeconfig');
  await writeFile(kubeconfig, JSON.stringify({
    apiVersion: 'v1', kind: 'Config', 'current-context': 'stand-in',
    clusters: [{ name: 'stand-in', cluster: { server: kube.url } }],
    users: [{ name: 'stand-in', user: { token: 'stand-in' } }],
    contexts: [{ name: 'stand-in', context: { cluster: 'stand-in', user: 'stand-in' } }],
  }));
  mongo = new MongoClient(`${mongoUri}${DATABASE}`);
  await mongo.connect();
  const shared = {
    JWT_SECRET: SECRET,
    MONGO_URI: `${mongoUri}${DATABASE}`,
    TEMPORAL_CONNECTION_ADDRESS: temporalAddress,
    TEMPORAL_NAMESPACE: namespace,
    TEMPORAL_ENGINE_TASK_QUEUE: QUEUE,
    MAIL_SMTP_URL: mail.url,
    MAIL_FROM: 'koala@removal.test',
    KUBECONFIG: kubeconfig,
    KUBECONFIG_PATH: kubeconfig,
    HEADSCALE_URL: headscale.url,
    HEADSCALE_API_KEY: 'stand-in',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${await freePort()}`,
  };
  backend = await startRole('combined', { ...shared, ADMIN_SETUP_CODE: SETUP_CODE });
  worker = await startWorker('engine-worker', 'src/worker-engine.ts', { ...shared, TEMPORAL_ENGINE_METRICS_PORT: String(await freePort()) });
  const adminEmail = `admin-${STAMP}@removal.test`;
  const adminPassword = randomBytes(18).toString('base64url');
  const made = await api('/auth/register', { body: { email: adminEmail, password: adminPassword, inviteCode: SETUP_CODE } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  adminCookie = sessionOf(await api('/auth/login', { body: { email: adminEmail, password: adminPassword } }))!;
  expect(adminCookie).toBeTruthy();
}, 240_000);

afterAll(async () => {
  await worker?.close();
  await backend?.close();
  await mongo?.db(DATABASE).dropDatabase();
  await mongo?.close();
  await kube?.close();
  await headscale?.close();
  await mail?.close();
  if (folder) await rm(folder, { recursive: true, force: true });
});

describe('an account removes itself, the backend and the engine worker each their own process', () => {
  it('a new account is invited, signs up with the emailed code and keeps a conversation', async () => {
    const invite = await api('/admin/invites', { body: {}, cookie: adminCookie });
    expect([200, 201], JSON.stringify(invite.body)).toContain(invite.status);
    const from = mail.received.length;
    const asked = await api('/auth/register', { body: { email, password, inviteCode: (invite.body as { code: string }).code } });
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    const code = await until(async () => {
      const sent = mail.received.slice(from).find((message) => message.to.includes(email) && mail.subjectOf(message) === 'Your Koala sign-up code');
      return sent ? /\b(\d{6})\b/.exec(textOf(sent))?.[1] : undefined;
    });
    const verified = await api('/auth/register/verify', { body: { id: (asked.body as { verify: string }).verify, code } });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    personCookie = sessionOf(verified)!;
    expect(personCookie).toBeTruthy();
    ownerId = ((await api('/auth/me', { cookie: personCookie })).body as { id: string }).id;
    expect(ownerId).toBeTruthy();
    const conversation = await api('/conversations', { body: { title: 'kept until the account goes' }, cookie: personCookie });
    expect(conversation.status, JSON.stringify(conversation.body)).toBeLessThan(300);
  });

  it('removal is refused without the email typed or without the password, then starts and signs the account out', async () => {
    expect((await api('/account/removal', { cookie: personCookie })).body).toEqual({ email, blockers: [] });
    expect((await api('/account', { method: 'DELETE', body: { confirm: 'nope', password }, cookie: personCookie })).status).toBe(400);
    expect((await api('/account', { method: 'DELETE', body: { confirm: email }, cookie: personCookie })).status).toBe(403);
    expect((await api('/account', { method: 'DELETE', body: { confirm: email, password: 'not-the-password-at-all' }, cookie: personCookie })).status).toBe(403);
    const removed = await api('/account', { method: 'DELETE', body: { confirm: email, password }, cookie: personCookie });
    expect(removed.status, JSON.stringify(removed.body)).toBe(202);
    expect(removed.cookies.join('\n')).toMatch(/session=;/);
    expect((await api('/conversations', { cookie: personCookie })).status).toBe(401);
    expect((await api('/auth/login', { body: { email, password } })).status).toBe(403);
  });

  it('an admin sees it going, until it is gone, and the engine worker removed its records', async () => {
    onTestFailed(() => console.log(`── backend ──\n${backend.logs(60)}\n── engine worker ──\n${worker.logs(80)}\n── kube asked ──\n${kube.asked.join('\n')}`));
    await until(async () => {
      const people = ((await api('/admin/people', { cookie: adminCookie })).body as { people: { id: string; removal?: { state: { state: string; reason?: string } } }[] }).people;
      const entry = people.find((person) => person.id === ownerId);
      if (entry?.removal?.state.state === 'failed') throw new Error(`the removal stopped: ${entry.removal.state.reason}`);
      return entry ? undefined : true;
    });
    const connection = await Connection.connect({ address: temporalAddress });
    try {
      const client = new Client({ connection, namespace, dataConverter: buildDataConverter(loadKeys({ JWT_SECRET: SECRET }).payload) });
      const result = await client.workflow.getHandle(removeAccountWorkflowId(ownerId)).result() as { stoppedWorkflows: number; records: Record<string, number> };
      expect(result.records.conversations ?? 0).toBeGreaterThan(0);
      expect(result.records.users).toBe(1);
    } finally {
      await connection.close();
    }
    expect(kube.asked.some((line) => line.startsWith('GET /api/v1/namespaces?') && decodeURIComponent(line).includes(`labelSelector=koala.dev/owner=${labelValue(ownerId)}`))).toBe(true);
    expect(headscale.asked).toContain(`GET /api/v1/user?name=${encodeURIComponent(`platform-${ownerId}`)}`);
  });

  it('nothing of it is left in any collection', async () => {
    const left: string[] = [];
    for (const name of ACCOUNT_DATA.byOwner) {
      const count = await mongo.db(DATABASE).collection(name).countDocuments({ ownerId });
      if (count) left.push(`${name}: ${count}`);
    }
    for (const name of [...ACCOUNT_DATA.byId, ACCOUNT_DATA.last]) {
      const count = await mongo.db(DATABASE).collection(name).countDocuments({ _id: ownerId as never });
      if (count) left.push(`${name}: ${count}`);
    }
    expect(left).toEqual([]);
  });
}, 300_000);
