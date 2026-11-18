import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { KOALA_INSTALL_PROGRESS, koalaInstallProgressPath, type PlacedKoala } from '@koala/engine-core/koala-install';
import { machineProgressContract } from '@koala/engine-core/testing/machine-progress';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkToRoot, type RootLink } from '../../../../local-agent/src/root-link.js';
import { placedFrom } from '../../../../local-agent/src/koala-install.js';
import { rootProgress } from '../../../../local-agent/src/root-progress.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { InstanceService, hashCredential, instanceIdFor } from '../../instances/services/InstanceService.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { MachineAccounts } from '../services/MachineAccounts.js';
import { KoalaInstalls } from '../services/KoalaInstalls.js';
import { machinesRouter } from '../routes/machines.js';
import { wireMachineAccounts } from './accounts.js';
import { temporalInstallWorkflows } from './sides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fresh = await emptiedEachTime();
const TOKEN = 'the-desk-token-0123456789-0123456789';

let env: TestWorkflowEnvironment;
let worker: Worker;
let running: Promise<void>;
let taskQueue = '';
let db: MongoDB;
let server: http.Server;
let url = '';
let accounts: MachineAccounts;
let installs: KoalaInstalls;
let folder = '';
let told: string[] = [];
let closing: (() => Promise<void>) | undefined;
const links: RootLink[] = [];

async function until<T>(look: () => Promise<T | undefined>): Promise<T> {
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    await new Promise((done) => setTimeout(done, 20));
  }
}

let current: () => MongoDB = () => { throw new Error('no database yet'); };

beforeAll(async () => {
  env = await temporalTestEnvironment();
  taskQueue = `koala-install-${Math.random().toString(36).slice(2, 8)}`;
  worker = await Worker.create({
    interceptors: { activity: activityInterceptors() },
    ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue,
    workflowBundle: await bundled(resolve(__dirname, '../../workflows/KoalaInstallWorkflow.ts')),
    activities: koalaInstallActivities({ db: async () => ({ db: current(), close: async () => undefined }), now: () => new Date() }),
  });
  running = worker.run();
}, 120_000);

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

beforeEach(async () => {
  db = await fresh();
  current = () => db;
  told = [];
  folder = await mkdtemp(path.join(tmpdir(), 'koala-placement-'));
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined });
  const app = express();
  app.use(express.json());
  server = http.createServer(app);
  const io = new SocketServer(server);
  let sockets: ReturnType<typeof wireMachineAccounts> | undefined;
  installs = new KoalaInstalls({
    devices: () => db.machines.getLocalAgentDevices(),
    places: () => instances,
    workflows: temporalInstallWorkflows(async () => env.client, taskQueue),
    toMachines: { placeKoala: (id, placed) => sockets!.placeKoala(id, placed) },
    toOwner: { installChanged: (ownerId) => { told.push(ownerId); } },
  });
  accounts = new MachineAccounts({
    store: db.machines,
    signing: identityKeysFrom(generateIdentityKey()),
    settings: { url: 'http://root.test' },
    koala: { of: async () => undefined },
    followers: { joined: async () => undefined, removed: async () => undefined, changed: async () => undefined },
    toOwner: { machinesChanged: () => undefined },
    toMachines: { removed: (id) => sockets!.removed(id), koala: (id, koala) => sockets!.koala(id, koala), online: (id) => sockets!.online(id) },
    installs,
  });
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  sockets = wireMachineAccounts({ io, db, accounts: () => accounts, installs: () => installs });
  const watching = db.instances.watchInstalls((instance) => { void installs.relay(instance); });
  await watching.ready;
  closing = () => watching.close();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.machines.saveLocalAgentDevice({ id: 'desk', ownerId: 'bo', name: 'desk', rootDir: '/home/bo/koala', createdAt: '2026-11-05T00:00:00Z', tokenHash: deviceTokenHash(TOKEN), koalaWanted: { name: 'bobby' } });
});

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  await closing?.();
  await new Promise<void>((done) => { server.close(() => done()); });
  await rm(folder, { recursive: true, force: true });
});

const agent = (onPlaceKoala: (raw: unknown) => boolean, token = TOKEN) => {
  const link = linkToRoot({
    rootUrl: url, token, configFile: path.join(folder, 'machine.json'), meshIp: async () => '100.64.0.7',
    onKoala: () => undefined, onRemoved: () => undefined, onPlaceKoala, say: () => undefined,
  });
  links.push(link);
  return link;
};

const tokenOf = (link: RootLink) => () => (link.socket.auth as { token: string }).token;
const reporting = (placed: PlacedKoala, link: RootLink) => rootProgress(`${url}${koalaInstallProgressPath(placed.installId)}`, tokenOf(link), fetch, { pause: async () => undefined });
const instanceOf = async () => (await db.instances.getInstances('bo'))[0]!;

describe('Koala put on a machine by root\'s install workflow, the machine doing the work', () => {
  it('asks the machine the moment it connects on the mesh, records each stage it reports, and is ready with where Koala answers once the last stage is done', async () => {
    const handed: PlacedKoala[] = [];
    const link = agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); });
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: 'desk', meshAddress: '100.64.0.7', name: 'bobby', image: '100.64.0.1:5001/nowrinkles/app', installId: expect.any(String) as unknown });
    expect(await instanceOf()).toMatchObject({ status: 'installing', machineId: 'desk', credentialHash: hashCredential(placed.credential), install: { id: placed.installId, state: 'asked', imageTag: 'v1' } });
    expect((await db.machines.getLocalAgentDevices())[0]?.koalaWanted).toBeUndefined();

    const root = reporting(placed, link);
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    await root.tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'done' });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started', line: 'waiting for job/instance-seed-1 runs' });
    await until(async () => ((await instanceOf()).install?.line ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'desk is putting Koala on itself: Putting Koala on this machine, waiting for job/instance-seed-1 runs', install: { state: 'installing', stage: 'koala' } });
    await root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' });
    await until(async () => ((await instanceOf()).status === 'ready' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', install: { state: 'ready' } });
    expect(told.every((ownerId) => ownerId === 'bo') && told.length > 3).toBe(true);
    await expect(root.tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'started' })).rejects.toThrow('root did not take this machine\'s progress (409): that install has ended ready');
  });

  it('asks the machine again when it comes back before the install finished, and fails with the stage and why it reports', async () => {
    const handed: PlacedKoala[] = [];
    const first = agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); });
    const placed = await until(async () => handed[0]);
    await reporting(placed, first).tell({ stage: 'cluster', title: 'Starting this machine\'s cluster', state: 'started' });
    await until(async () => (tokenOf(first)() !== TOKEN ? true : undefined));
    first.close();
    const second = agent((raw) => { const again = placedFrom(raw); if (again) handed.push(again); return Boolean(again); }, tokenOf(first)());
    const again = await until(async () => handed[1]);
    expect(again.installId).toBe(placed.installId);
    await reporting(again, second).tell({ stage: 'koala', title: 'Putting Koala on this machine', state: 'failed', why: 'job/instance-seed-2 failed: Mongo refused its password' });
    await until(async () => ((await instanceOf()).status === 'failed' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'failed', detail: 'Putting Koala on desk stopped at Putting Koala on this machine: job/instance-seed-2 failed: Mongo refused its password', install: { state: 'failed', stage: 'koala', why: 'job/instance-seed-2 failed: Mongo refused its password' } });
  });

  it('hears only the machine the install is for, with its own token', async () => {
    const handed: PlacedKoala[] = [];
    const link = agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); });
    const placed = await until(async () => handed[0]);
    const TOKEN_NOW = tokenOf(link)();
    const post = (token: string | undefined, installId: string) => fetch(`${url}${koalaInstallProgressPath(installId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ stage: 'koala', title: 'Koala', state: 'started' }) });
    expect((await post(undefined, placed.installId)).status).toBe(401);
    expect((await post(`${TOKEN_NOW}-not`, placed.installId)).status).toBe(401);
    expect((await post(TOKEN_NOW, 'another-install')).status).toBe(404);
    expect((await post(TOKEN_NOW, placed.installId)).status).toBe(204);
  });
});

machineProgressContract('root\'s install route, a new install for each report', KOALA_INSTALL_PROGRESS, async () => {
  await accounts.recordMeshIp('desk', '100.64.0.7');
  return {
    credential: async () => TOKEN,
    post: async (token, body) => {
      const started = await installs.start('bo', (await db.machines.getLocalAgentDevices())[0]!, 'bobby');
      if (!started.ok) throw new Error(started.error);
      return (await fetch(`${url}${koalaInstallProgressPath(started.value.installId)}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).status;
    },
  };
});
