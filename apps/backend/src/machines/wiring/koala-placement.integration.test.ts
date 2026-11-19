import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { KOALA_INSTALL_CHANGED, KOALA_INSTALL_PROGRESS, koalaInstallProgressPath, type PlacedKoala } from '@koala/engine-core/koala-install';
import { machineProgressContract } from '@koala/engine-core/testing/machine-progress';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linkToRoot, type RootLink } from '../../../../local-agent/src/root-link.js';
import { placedFrom } from '../../../../local-agent/src/koala-install.js';
import { rootProgress } from '../../../../local-agent/src/root-progress.js';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { roleFromEnv } from '../../platform/lib/platform-role.js';
import { generateIdentityKey } from '../../instances/lib/identity-token.js';
import { InstanceService, hashCredential, instanceIdFor } from '../../instances/services/InstanceService.js';
import { koalaInstallWorkflowId } from '../../instances/lib/koala-installs.js';
import { InstanceReach } from '../../instances/services/InstanceReach.js';
import { koalaInstallActivities } from '../../activities/KoalaInstallActivities.js';
import { bundled, temporalTestEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { deviceTokenHash } from '../lib/device-tokens.js';
import { ProjectRepoService } from '../../projects/services/ProjectRepoService.js';
import type { GiteaService } from '../../projects/services/GiteaService.js';
import { userRoom } from '../../engine-host/temporal/stream-worker.js';
import type { MachineAccounts } from '../services/MachineAccounts.js';
import type { KoalaInstalls } from '../services/KoalaInstalls.js';
import { machinesRouter } from '../routes/machines.js';
import { instancesRouter } from '../../instances/routes/instances.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { reopening } from '@koala/engine-core/reopening';
import { machineSides, temporalInstallWorkflows } from './sides.js';
import { until } from '../testing/wiring-world.js';

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
let told: unknown[] = [];
let temporalDown = false;
let closing: (() => Promise<void>) | undefined;
let movesStarted: string[] = [];
let service: InstanceService;
const links: RootLink[] = [];

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
});

afterAll(async () => {
  worker?.shutdown();
  await running;
  await env?.teardown();
});

beforeEach(async () => {
  db = await fresh();
  current = () => db;
  told = [];
  temporalDown = false;
  folder = await mkdtemp(path.join(tmpdir(), 'koala-placement-'));
  const instances = new InstanceService(db, {
    rootUrl: 'http://root.test', rootPublicKeys: () => ['PEM'], meshLoginServer: 'https://mesh.test', registry: '100.64.0.1:5001', imageTag: 'v1', domain: '',
    reach: new InstanceReach({ open: true, domain: '' }),
    installs: { setupHeard: (installId, report) => installs.setupHeard(installId, report), progressHeard: (installId, progress) => installs.progressHeard(installId, progress), stop: (installId) => installs.stop(installId) },
    pool: { slots: 1, trialDays: 14 },
    moves: { joinCode: (ownerId, koalaName) => accounts.createJoinCode(ownerId, koalaName, true), poolClusterId: (name) => `pool-${name}` },
  }, { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined }, () => new Date(), () => undefined, {
    start: async () => undefined, trialChanged: async () => undefined, remove: async () => undefined,
    move: async (instanceId) => { movesStarted.push(instanceId); },
  });
  movesStarted = [];
  service = instances;
  const app = express();
  app.use(express.json());
  server = http.createServer(app);
  const io = new SocketServer(server);
  io.on('connection', (socket) => { void socket.join(userRoom('bo')); });
  const sides = machineSides({
    role: roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: generateIdentityKey() }),
    db, io, dataKey: 'koala-placement-key', publicUrl: 'http://root.test', meshLoginServer: 'https://mesh.test',
    mesh: { createPreAuthKey: async () => ({ key: 'k' }), removeNode: async () => undefined },
    devices: { status: () => ({ online: false }), tell: () => true, ask: async () => undefined as never, drop: () => undefined },
    projects: new ProjectRepoService(db, {} as GiteaService, 'koala-placement-key'),
    instances: () => ({ places: instances }),
    installWorkflows: temporalInstallWorkflows(async () => {
      if (temporalDown) throw new Error('Temporal is not answering');
      return env.client;
    }, taskQueue),
  });
  accounts = sides.accounts!;
  installs = sides.installs!;
  app.use('/api/machines', machinesRouter({ accounts, installs, bundle: { path: async () => '/nowhere', sha256: async () => 'ab'.repeat(32) } }));
  app.use('/api/instances', instancesRouter({ instances, chart: async () => '/nowhere', operatorOnly: (_req: Request, _res: Response, next: NextFunction) => next() }));
  await sides.installsWatched!.ready;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser: ClientSocket = connect(url, { transports: ['websocket'], reconnection: false, forceNew: true });
  browser.on(KOALA_INSTALL_CHANGED, (said: unknown) => told.push(said));
  await until(async () => (browser.connected ? true : undefined));
  closing = async () => { browser.close(); await sides.installsWatched!.close(); await io.close(); };
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
  it('asks the machine the moment it connects on the mesh, records each stage it reports and each piece Koala sets up, and is ready with where Koala answers once the last piece is up', async () => {
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
    await until(async () => ((await instanceOf()).url ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up', url: 'http://100.64.0.7:30320', install: { state: 'installing' } });
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, credential: placed.credential }, wait: reopening(1), log: () => undefined });
    expect(await koala.setup({ revision: 1, progress: { stage: 'gitea', title: 'Gitea, your repositories and images', state: 'started', line: 'waiting for statefulset/gitea in gitea: 0 of 1 ready' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).install?.stage === 'gitea' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'installing', detail: 'Koala on desk is setting itself up: Gitea, your repositories and images, waiting for statefulset/gitea in gitea: 0 of 1 ready' });
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).status === 'ready' ? true : undefined));
    expect(await instanceOf()).toMatchObject({ status: 'ready', url: 'http://100.64.0.7:30320', running: 'v1', install: { state: 'ready' }, setup: { revision: 1, state: 'up' } });
    expect(told.length > 3 && told.every((said) => JSON.stringify(said) === '{}')).toBe(true);
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

  it('stops following the install when the machine is removed on the way, cancelling its workflow', async () => {
    const handed: PlacedKoala[] = [];
    agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); });
    const placed = await until(async () => handed[0]);
    expect(await accounts.remove('bo', 'desk')).toBe(true);
    const workflow = env.client.workflow.getHandle(koalaInstallWorkflowId(placed.installId));
    expect(await until(async () => ((await workflow.describe()).status.name === 'CANCELLED' ? true : undefined))).toBe(true);
    expect(await db.machines.getLocalAgentDevices()).toEqual([]);
  });

  it('fails the install, saying why, and tells the owner, when root cannot start its workflow', async () => {
    temporalDown = true;
    agent(() => true);
    const failed = await until(async () => { const instance = (await db.instances.getInstances('bo'))[0]; return instance?.install?.state === 'failed' ? instance : undefined; });
    expect(failed).toMatchObject({ status: 'failed', detail: 'root could not start putting Koala on desk: Temporal is not answering', install: { state: 'failed', why: 'root could not start putting Koala on desk: Temporal is not answering' } });
    expect((await db.machines.getLocalAgentDevices())[0]).toMatchObject({ koalaRefused: { reason: 'root could not start putting Koala on desk: Temporal is not answering' } });
    await until(async () => (told.length > 0 ? true : undefined));
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

describe('Koala moved from Koala\'s servers onto a machine that joins with the move\'s command', () => {
  it('joins the machine, hands it the move with its own credential, follows the move to the switch, and leaves the pool copy serving until then', async () => {
    await db.machines.deleteLocalAgentDevice('desk');
    const pool = { ports: { backend: 35000, edge: 35001, registry: 35002 }, startedAt: new Date().toISOString(), trialEndsAt: new Date(Date.now() + 14 * 86_400_000).toISOString() };
    await db.instances.saveInstance({ id: instanceIdFor('bo'), ownerId: 'bo', name: 'bobby', url: 'https://bobby.koala.dev', status: 'ready', createdAt: 't', updatedAt: 't', credentialHash: hashCredential('pool-secret'), meshIp: '100.64.0.1', pool });
    const started = await service.startMove('bo');
    if (!started.ok) throw new Error(started.error);
    expect(started.value.command).toMatch(/^curl -fsSL http:\/\/root\.test\/machine\.sh \| sh -s -- \S+$/);
    expect(movesStarted).toEqual([instanceIdFor('bo')]);
    const code = started.value.command.split(' ').at(-1);
    const joining = await fetch(`${url}/api/machines/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, hostname: 'desk', rootDir: '/home/bo/koala' }) });
    expect(joining.status).toBe(200);
    const { env: joined } = await joining.json() as { env: Record<string, string> };

    const handed: PlacedKoala[] = [];
    const link = agent((raw) => { const placed = placedFrom(raw); if (placed) handed.push(placed); return Boolean(placed); }, joined.KOALA_DEVICE_TOKEN);
    const placed = await until(async () => handed[0]);
    expect(placed).toMatchObject({ instanceId: instanceIdFor('bo'), machineId: joined.KOALA_DEVICE_ID, name: 'bobby', move: { fromClusterId: 'pool-bobby' } });
    expect(await instanceOf()).toMatchObject({
      status: 'ready', url: 'https://bobby.koala.dev', credentialHash: hashCredential('pool-secret'),
      install: { id: placed.installId, move: true }, move: { credentialHash: hashCredential(placed.credential), target: { machine: 'desk', meshIp: '100.64.0.7' } },
    });

    const root = reporting(placed, link);
    await root.tell({ stage: 'koala', title: 'Bringing Koala over', state: 'started', line: 'waiting for job/move-mongo-1 runs' });
    await until(async () => ((await instanceOf()).move?.state === 'copying' ? true : undefined));
    expect((await instanceOf()).move).toMatchObject({ detail: 'Moving Koala to desk: Bringing Koala over, waiting for job/move-mongo-1 runs' });
    await root.tell({ stage: 'koala-moved', title: 'Starting Koala on this machine', state: 'done', url: 'http://100.64.0.7:30320' });
    await until(async () => ((await instanceOf()).move?.target?.url ? true : undefined));
    const koala = new InstanceReporter({ root: { url, instanceId: placed.instanceId, credential: placed.credential }, wait: reopening(1), log: () => undefined });
    expect(await koala.setup({ revision: 1, progress: { stage: 'set-up', title: 'Koala is set up', state: 'done' } })).toEqual({ ok: true });
    await until(async () => ((await instanceOf()).install?.state === 'ready' ? true : undefined));
    expect(await instanceOf()).toMatchObject({
      status: 'ready', url: 'https://bobby.koala.dev', credentialHash: hashCredential('pool-secret'),
      move: { state: 'switching', target: { url: 'http://100.64.0.7:30320' }, setup: { revision: 1, state: 'up' } },
    });
    expect((await instanceOf()).machineId).toBeUndefined();
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
