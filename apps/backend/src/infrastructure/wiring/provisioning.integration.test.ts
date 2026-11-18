import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import axios from 'axios';
import { Server as SocketServer } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { PROVISIONING_CHANGED, type ProvisioningView } from '@koala/engine-core/koala-install';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { harnessApp } from '../../platform/routes/test-harness.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { RUN_ID_MEMO, workflowOfRun } from '../../platform/lib/workflow-ids.js';
import { bundled, realTemporalEnvironment } from '../../workflows/temporal-test-env.js';
import type { RunStarter, StartRunRequest } from '../../engine-host/registries/run-starter.js';
import { engineProvisionRuns } from '../../engine-host/provision-runs.js';
import { Provisioning } from '../services/Provisioning.js';
import { isOff } from '../../platform/index.js';
import { wireProvisioning } from './provisioning.js';
import { PROVISION_AGENT } from '../../extensions/provision/names.js';

const OWNER = { id: 'owner-1', email: 'owner@example.com' };
const WORKFLOWS = fileURLToPath(new URL('../testing/provision.fixture-workflow.ts', import.meta.url));

let env: TestWorkflowEnvironment;
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
  worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(WORKFLOWS) });
  working = worker.run();
}, 120_000);

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

async function koalaAt(clusterId: string) {
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
    root: { setup: async () => ({ ok: true }) },
    koala: { ownerId: OWNER.id, clusterId, revision: 2 },
  });
  if (isOff(provisioning)) throw new Error(provisioning.off);
  closing.push(() => provisioning.close());
  return { db, url, owner, provisioning };
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
    const provisioning = new Provisioning({
      store: db.infrastructure,
      runs: engineProvisionRuns({ runs, client: () => env.client.workflow, agent: PROVISION_AGENT }),
      root: { setup: async () => ({ ok: true }) },
      koala: { ownerId: OWNER.id, clusterId, revision: 2 },
      changed: () => undefined,
      log: () => undefined,
    });
    closing.push(() => provisioning.close());

    const [one, two] = await Promise.all([provisioning.ensure({ kind: 'koala', clusterId }, 'missing'), provisioning.ensure({ kind: 'koala', clusterId }, 'asked')]);
    expect(one.id).toBe(two.id);
    expect(started.filter((request) => String(request.runId).startsWith(`provision-${clusterId}~`))).toHaveLength(1);

    const settled = provisioning.settled(one.id);
    await env.client.workflow.getHandle(`provision-${clusterId}`).signal('cancelRun');
    expect(await settled).toEqual({ state: 'failed', why: 'the setup\'s run finished without saying how its pieces ended' });
  });
});
