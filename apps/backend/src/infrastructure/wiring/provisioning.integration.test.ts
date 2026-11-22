import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import axios from 'axios';
import express from 'express';
import { reopening } from '@koala/engine-core/reopening';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import { Worker } from '@temporalio/worker';
import { PROVISIONING_CHANGED, type ProvisioningView } from '@koala/engine-core/koala-install';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { harnessApp } from '../../platform/routes/test-harness.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { RUN_ID_MEMO, workflowOfRun } from '../../platform/lib/workflow-ids.js';
import { bundled, realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { createRunStarter, type RunStarter, type StartRunRequest } from '../../engine-host/registries/run-starter.js';
import { createAgentRegistry } from '../../engine-host/registries/registry.js';
import { temporalWorkflowStarter } from '../../engine-host/temporal/workflow-starter.js';
import { runsActingAsTheirOwner } from '../../engine/testing/run-grants.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import { testDataDir } from '../../platform/testing/data-dir.js';
import type { ProvisioningRecord } from '../lib/provisioning.js';
import { engineProvisionRuns } from '../../engine-host/provision-runs.js';
import { ProvisionAsks, Provisioning, type ProvisionRoot, type ProvisionRuns } from '../services/Provisioning.js';
import { InstanceReporter } from '../../instances/services/InstanceReporter.js';
import { pieceHeard } from '../lib/provisioning.js';
import { isOff } from '../../platform/index.js';
import { wireProvisioning } from './provisioning.js';
import { PROVISION_AGENT } from '../../extensions/provision/names.js';
import { testWorker } from '../../workflows/testing/test-worker.js';
import type { TestTemporal } from '@koala/engine-core/testing/temporal';

const OWNER = { id: 'owner-1', email: 'owner@example.com' };
const WORKFLOWS = fileURLToPath(new URL('../testing/provision.fixture-workflow.ts', import.meta.url));

let env: TestTemporal;
let worker: Worker;
let working: Promise<void>;
const taskQueue = `provision-${Math.random().toString(36).slice(2, 8)}`;
const started: StartRunRequest[] = [];
const closing: (() => Promise<void>)[] = [];

const runs: Pick<RunStarter, 'start'> = {
  start: async (request) => {
    started.push(request);
    await env.client.workflow.start('provisionStandIn', { taskQueue, workflowId: workflowOfRun(request.runId!), memo: { [RUN_ID_MEMO]: request.runId }, ...startedFor(request.ownerId) });
    return { runId: request.runId!, agentSlug: request.agentSlug, loopId: 'provision' };
  },
};

beforeAll(async () => {
  env = await realTemporalEnvironment();
  worker = await testWorker(env, { namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(WORKFLOWS) });
  working = worker.run();
});

afterAll(async () => {
  for (const close of closing.splice(0).reverse()) await close();
  worker?.shutdown();
  await working;
  await env?.teardown();
});

function hearing(socket: Socket) {
  const heard: ProvisioningView[] = [];
  const waiting: { until: (view: ProvisioningView) => boolean; done: (view: ProvisioningView) => void }[] = [];
  socket.on(PROVISIONING_CHANGED, (view: ProvisioningView) => {
    heard.push(view);
    for (const wait of [...waiting]) if (wait.until(view)) { waiting.splice(waiting.indexOf(wait), 1); wait.done(view); }
  });
  const when = (until: (view: ProvisioningView) => boolean) => {
    const already = heard.find(until);
    return already ? Promise.resolve(already) : new Promise<ProvisioningView>((done) => { waiting.push({ until, done }); });
  };
  return { heard, when };
}

async function koalaAt(clusterId: string, root: ProvisionRoot = { setup: async () => ({ ok: true }), setupAsked: async () => undefined }) {
  const db = await testDatabase();
  const app = await harnessApp({ prefix: '/unused', router: () => Router(), claims: { role: 'instance', instanceOwnerId: OWNER.id } }, db, () => OWNER);
  const server = http.createServer(app);
  const io = new SocketServer(server);
  io.on('connection', (socket) => { void socket.join(`user:${OWNER.id}`); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const socket = connect(url, { transports: ['websocket'] });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const owner = hearing(socket);
  closing.push(async () => { socket.close(); await io.close(); });
  const provisioning = wireProvisioning({
    tenant: { use: (path, router) => app.use(path, router) },
    db,
    io,
    runs,
    client: () => env.client.workflow,
    connected: async () => undefined,
    root,
    up: () => undefined,
    koala: { ownerId: OWNER.id, clusterId, revision: 2 },
  });
  if (isOff(provisioning)) throw new Error(provisioning.off);
  closing.push(() => provisioning.close());
  return { db, url, owner, provisioning };
}

function provisioningOn(db: Awaited<ReturnType<typeof testDatabase>>, clusterId: string, provisionRuns: ProvisionRuns): Provisioning {
  const provisioning = new Provisioning({
    store: db.infrastructure,
    runs: provisionRuns,
    root: { setup: async () => ({ ok: true }), setupAsked: async () => undefined },
    koala: { ownerId: OWNER.id, clusterId, revision: 2 },
    changed: () => undefined,
    log: () => undefined,
  });
  closing.push(() => provisioning.close());
  return provisioning;
}

describe('Koala setting itself up after a new chart revision, on real Mongo and Temporal', () => {
  it('starts one run for the revision, tells its owner, fails a run that ended without a mark with how it ended, and starts a new run when the person asks', async () => {
    const clusterId = `machine-desk-${taskQueue}`;
    const { url, owner, db } = await koalaAt(clusterId);

    const running = await owner.when((view) => view.state === 'running');
    expect(running).toMatchObject({ target: { kind: 'koala', clusterId }, revision: 2, reason: 'revision' });
    expect(running).not.toHaveProperty('workflowId');
    await owner.when(() => owner.heard.filter((view) => view.id === running.id).length >= 2);
    expect((await db.infrastructure.getProvisioningRun(running.id))?.workflowId).toBe(`provision-${clusterId}`);
    expect((await env.client.workflow.getHandle(`provision-${clusterId}`).describe()).memo?.[RUN_ID_MEMO]).toBe(running.id);
    expect((await axios.get(`${url}/api/infrastructure/provisioning`)).data).toEqual({ setups: [expect.objectContaining({ id: running.id, state: 'running' })], can: ['set-up-again'] });

    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
    const failed = await owner.when((view) => view.id === running.id && view.state === 'failed');
    expect(failed.why).toBe('the setup\'s run finished without saying how its pieces ended');

    const again = await axios.post<ProvisioningView>(`${url}/api/infrastructure/provisioning/again`, { clusterId });
    expect(again.status).toBe(202);
    expect(again.data).toMatchObject({ reason: 'asked', state: 'running', target: { kind: 'koala', clusterId } });
    expect(again.data.id).not.toBe(running.id);
    expect((await env.client.workflow.getHandle(`provision-${clusterId}`).describe()).memo?.[RUN_ID_MEMO]).toBe(again.data.id);
    expect(started.filter((request) => String(request.runId).startsWith(`provision-${clusterId}~`)).map((request) => (request.inputs as { reason: string }).reason)).toEqual(['revision', 'asked']);

    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
    await owner.when((view) => view.id === again.data.id && view.state === 'failed');
  });

  it('starts one run when two ask at once, the cluster holding one running run', async () => {
    const clusterId = `machine-lab-${taskQueue}`;
    const db = await testDatabase();
    const provisioning = provisioningOn(db, clusterId, engineProvisionRuns({ runs, client: () => env.client.workflow, connected: async () => undefined, agent: PROVISION_AGENT }));
    await provisioning.start();

    const [one, two] = await Promise.all([provisioning.ensure({ kind: 'koala', clusterId }, 'missing'), provisioning.ensure({ kind: 'koala', clusterId }, 'asked')]);
    expect(one.id).toBe(two.id);
    expect(started.filter((request) => String(request.runId).startsWith(`provision-${clusterId}~`))).toHaveLength(1);

    const settled = provisioning.settled(one.id);
    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
    expect(await settled).toEqual({ state: 'failed', why: 'the setup\'s run finished without saying how its pieces ended' });
  });

  it('shows its owner, on the setup, that root refused hearing how it goes, with root\'s own words, after waiting while root was down', async () => {
    const clusterId = `machine-moving-${taskQueue}`;
    const heardByRoot: unknown[] = [];
    const rootApp = express();
    rootApp.use(express.json());
    rootApp.post('/api/instances/status', (req, res) => {
      heardByRoot.push(req.body);
      if (heardByRoot.length === 1) return res.status(503).end();
      return res.status(409).json({ error: 'this Koala is moving to another machine' });
    });
    const rootServer = http.createServer(rootApp);
    await new Promise<void>((resolve) => rootServer.listen(0, '127.0.0.1', () => resolve()));
    closing.push(() => new Promise<void>((resolve) => { rootServer.close(() => resolve()); }));
    const reporter = new InstanceReporter({ root: { url: `http://127.0.0.1:${(rootServer.address() as AddressInfo).port}`, instanceId: 'inst-1', token: async () => 'service-token' }, wait: reopening(1), log: () => undefined });
    const { url, owner, db } = await koalaAt(clusterId, reporter);

    const running = await owner.when((view) => view.state === 'running');
    const opened = (await db.infrastructure.getProvisioningRun(running.id))!;
    const started = pieceHeard(opened, { stage: 'egress', title: 'The egress proxy', state: 'started', line: 'deployment/egress-proxy: 0 of 1 ready' }, new Date().toISOString());
    await db.infrastructure.patchProvisioning(opened.id, { pieces: started.pieces }, true);

    const refused = await owner.when((view) => view.id === running.id && view.root !== undefined);
    expect(refused.root?.why).toBe('root refused hearing that The egress proxy is under way: this Koala is moving to another machine (409)');
    expect(heardByRoot).toHaveLength(2);
    expect((await axios.get<{ setups: ProvisioningView[] }>(`${url}/api/infrastructure/provisioning`)).data.setups[0]?.root?.why).toBe(refused.root?.why);

    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
    await owner.when((view) => view.id === running.id && view.state === 'failed');
  });

  it('starts the setup the cluster worker asks for on another machine by opening its record, and the cluster worker hears how it ended', async () => {
    const clusterId = `machine-desk-${taskQueue}`;
    const labId = `machine-lab-${taskQueue}`;
    const { owner, db } = await koalaAt(clusterId);
    await owner.when((view) => view.target.clusterId === clusterId && view.state === 'running');
    const asks = new ProvisionAsks({ store: db.infrastructure, koala: { ownerId: OWNER.id, revision: 2 } });

    const asked = await asks.ensure({ kind: 'machine', clusterId: labId, machine: 'lab', deviceId: 'device-lab' }, 'missing');
    expect(asked).toMatchObject({ reason: 'missing', state: 'running', pieces: [{ key: 'monitoring', title: 'lab\'s collector', state: 'waiting' }] });
    const settled = asks.settled(asked.id);
    const heard = await owner.when((view) => view.id === asked.id && view.state === 'running');
    expect(heard.target).toEqual({ kind: 'machine', clusterId: labId, machine: 'lab', deviceId: 'device-lab' });
    const named = await new Promise<string>((done) => {
      const watching = db.infrastructure.watchProvisioning((record) => { if (record.id === asked.id && record.workflowId) { void watching.close(); done(record.workflowId); } });
      void db.infrastructure.getProvisioningRun(asked.id).then((record) => { if (record?.workflowId) { void watching.close(); done(record.workflowId); } });
    });
    expect(named).toBe(`provision-${labId}`);
    expect(started.filter((request) => request.runId === asked.id).map((request) => request.inputs)).toEqual([{ ownerId: OWNER.id, recordId: asked.id, target: heard.target, revision: 2, reason: 'missing' }]);

    await env.client.workflow.getHandle(`provision-${labId}`).signal('cancelRun');
    expect(await settled).toEqual({ state: 'failed', why: 'the setup\'s run finished without saying how its pieces ended' });
    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
  });

  async function setUpBeforeTheEngineConnects(clusterId: string) {
    const db = await testDatabase();
    const bridge = new TemporalBridge(db, testDataDir(), undefined, undefined, undefined, { connect: async () => env.client });
    const engineRuns = createRunStarter({ ...runsActingAsTheirOwner(), registry: createAgentRegistry(), workflows: () => (bridge.isReady() ? temporalWorkflowStarter(bridge.client.workflow) : undefined) });
    const provisioning = provisioningOn(db, clusterId, engineProvisionRuns({ runs: engineRuns, client: () => (bridge.isReady() ? bridge.client.workflow : undefined), connected: () => bridge.connected(), agent: PROVISION_AGENT }));
    const opened = new Promise<ProvisioningRecord>((done) => {
      const watching = db.infrastructure.watchProvisioning((record) => { if (record.target.clusterId === clusterId) { void watching.close(); done(record); } });
    });
    const starting = provisioning.start();
    return { db, bridge, starting, record: await opened };
  }

  it('waits for the engine to connect to Temporal before starting the setup it was asked for, then starts it', async () => {
    const clusterId = `machine-early-${taskQueue}`;
    const { db, bridge, starting, record } = await setUpBeforeTheEngineConnects(clusterId);
    await bridge.start();
    await starting;

    expect(await db.infrastructure.getProvisioningRun(record.id)).toMatchObject({ state: 'running', workflowId: `provision-${clusterId}` });
    expect((await env.client.workflow.getHandle(`provision-${clusterId}`).describe()).status.name).toBe('RUNNING');
  });

  it('fails the setup it was asked for, saying why, when the backend stops before the engine ever connects', async () => {
    const clusterId = `machine-stopped-${taskQueue}`;
    const { db, bridge, starting, record } = await setUpBeforeTheEngineConnects(clusterId);
    await bridge.stop();
    await starting;

    expect(await db.infrastructure.getProvisioningRun(record.id)).toMatchObject({ state: 'failed', why: 'the setup could not start: the backend stopped before it connected to Temporal, so nothing it was waiting to start will start' });
  });
});
