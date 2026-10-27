import http2 from 'node:http2';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { buildDataConverter, type BlobReach } from '@koala/engine-core/payloads';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { inMemoryPayloadBlobs } from '../../platform/lib/payload-storage.js';
import { MachineTemporalGateway } from './MachineTemporalGateway.js';

let env: TestWorkflowEnvironment;
let gateway: MachineTemporalGateway;
let address = '';
const refusals: string[] = [];
const blobs = inMemoryPayloadBlobs();
const PAYLOAD_KEY = 'p'.repeat(64);
const handedBlobs = new Set<string>();
const upstreamAuth: (string | undefined)[] = [];
let relay: http2.Http2Server;
let relayed: http2.ClientHttp2Session;

const withoutPseudo = (headers: http2.IncomingHttpHeaders, keep: string[] = []) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(':') || keep.includes(name)));

async function recordingRelay(to: string): Promise<string> {
  relayed = http2.connect(`http://${to}`);
  relay = http2.createServer();
  relay.on('stream', (stream, headers) => {
    upstreamAuth.push(headers.authorization);
    const up = relayed.request(withoutPseudo(headers, [':method', ':path']));
    let trailers: http2.OutgoingHttpHeaders = {};
    up.on('trailers', (ended) => { trailers = withoutPseudo(ended); });
    up.on('response', (answered) => {
      if (answered['grpc-status'] !== undefined) return stream.respond(withoutPseudo(answered, [':status']), { endStream: true });
      stream.respond(withoutPseudo(answered, [':status']), { waitForTrailers: true });
      stream.once('wantTrailers', () => stream.sendTrailers(trailers));
      up.pipe(stream);
    });
    stream.pipe(up);
    stream.on('close', () => { if (!up.closed) up.close(http2.constants.NGHTTP2_CANCEL); });
  });
  return new Promise((done) => relay.listen(0, '127.0.0.1', () => done(`127.0.0.1:${(relay.address() as { port: number }).port}`)));
}
const asDevice = (deviceId: string): BlobReach => ({
  put: async (stored) => { await blobs.putFrom(deviceId, stored); for (const blob of stored) handedBlobs.add(blob.id); },
  get: (ids) => blobs.getHanded(deviceId, ids),
});

beforeAll(async () => {
  env = await temporalTestEnvironment();
  gateway = new MachineTemporalGateway({
    upstream: await recordingRelay(env.address),
    upstreamKey: () => 'the-gateway-token',
    namespace: env.namespace ?? 'default',
    keys: () => ['the-key'],
    deviceOf: async (token) => ({ 'token-d1': { id: 'd1' }, 'token-d2': { id: 'd2' } } as Record<string, { id: string }>)[token],
    handed: async (workflowId, deviceId) => {
      for (const [id, blob] of blobs.stored) if (blob.workflowId === workflowId) handedBlobs.add(id);
      await blobs.handTo(workflowId, deviceId);
    },
    log: (line) => refusals.push(line),
  });
  address = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  relayed?.close();
  await new Promise((done) => (relay ? relay.close(done) : done(undefined)));
  await env?.teardown();
}, 60_000);

const asMachine = (token: string) => NativeConnection.connect({ address, metadata: { authorization: `Bearer ${token}` } });

const refusedWith = async (attempt: Promise<unknown>, said: RegExp) => {
  const err = await attempt.then(() => undefined, (failure: unknown) => failure);
  const chain: string[] = [];
  for (let at = err as { message?: string; details?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) chain.push(at.details ?? '', at.message ?? '');
  expect(chain.join(' | ')).toMatch(said);
};

describe('a machine reaching Temporal through the gateway', () => {
  it('takes its own work, heartbeats and answers it, as if it spoke to Temporal itself', async () => {
    const machine = await Worker.create({
      connection: await asMachine('token-d1'),
      taskQueue: 'device-d1',
      activities: { Echo: async (text: string) => { Context.current().heartbeat(); return `machine says ${text}`; } },
    });
    const workflows = await Worker.create({ connection: env.nativeConnection, taskQueue: 'gateway-test', workflowsPath: resolve(__dirname, 'MachineTemporalGateway.fixture-workflow.ts') });
    const answer = await workflows.runUntil(machine.runUntil(env.client.workflow.execute('askMachine', { taskQueue: 'gateway-test', workflowId: `ask-${Date.now()}`, args: ['d1', 'hello'] })));
    expect(answer).toBe('machine says hello');
  }, 120_000);

  it('lets a machine read the large payloads of the tasks it was handed, and no other machine', async () => {
    const machine = await Worker.create({
      connection: await asMachine('token-d1'),
      taskQueue: 'device-d1',
      dataConverter: buildDataConverter(PAYLOAD_KEY, asDevice('d1')),
      activities: { Echo: async (text: string) => `machine says ${text}` },
    });
    const converter = buildDataConverter(PAYLOAD_KEY, blobs);
    const workflows = await Worker.create({ connection: env.nativeConnection, taskQueue: 'gateway-big', dataConverter: converter, workflowsPath: resolve(__dirname, 'MachineTemporalGateway.fixture-workflow.ts') });
    const client = new Client({ connection: env.connection, namespace: env.namespace ?? 'default', dataConverter: converter });
    const pasted = 'a'.repeat(100) + Buffer.alloc(200_000).map(() => Math.floor(Math.random() * 26) + 97).toString();
    const before = new Set(blobs.stored.keys());
    const answer = await workflows.runUntil(machine.runUntil(client.workflow.execute('askMachine', { taskQueue: 'gateway-big', workflowId: `big-${Date.now()}`, args: ['d1', pasted] })));
    expect(answer).toBe(`machine says ${pasted}`);
    const offloaded = [...blobs.stored.keys()].filter((id) => !before.has(id));
    const itsOwn = offloaded.filter((id) => handedBlobs.has(id));
    expect(itsOwn.length).toBeGreaterThanOrEqual(2);
    expect(itsOwn.length).toBeLessThan(offloaded.length);
    expect([...(await blobs.getHanded('d1', offloaded)).keys()].sort()).toEqual(itsOwn.sort());
    expect((await blobs.getHanded('d2', offloaded)).size).toBe(0);
  }, 120_000);

  it('speaks to Temporal with its own token, never the machine\'s', () => {
    expect(upstreamAuth.length).toBeGreaterThan(0);
    expect(new Set(upstreamAuth)).toEqual(new Set(['Bearer the-gateway-token']));
  });

  it('never lets a machine take another machine\'s work', async () => {
    const thief = await Worker.create({ connection: await asMachine('token-d2'), taskQueue: 'device-d1', activities: { Echo: async () => 'stolen' } });
    await thief.runUntil(new Promise((done) => setTimeout(done, 3_000)));
    expect(refusals.some((line) => line.includes('refused PollActivityTaskQueue from d2: a machine takes work only from its own queue, device-d2'))).toBe(true);
  }, 60_000);

  it('refuses everything else a machine might ask, and anyone without a machine\'s token', async () => {
    const client = new Client({ connection: await Connection.connect({ address, metadata: { authorization: 'Bearer token-d1' } }), namespace: env.namespace ?? 'default' });
    await refusedWith(client.workflow.list()[Symbol.asyncIterator]().next(), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.start('askMachine', { taskQueue: 'gateway-test', workflowId: 'not-allowed', args: ['d1', 'x'] }), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.getHandle('anything').signal('cancelRun'), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.activity.complete(Buffer.from('a-forged-task-token'), 'done'), /tasks it was handed|PERMISSION_DENIED/);
    await refusedWith(Connection.connect({ address, metadata: { authorization: 'Bearer not-a-machine' } }), /this machine is not known here; add it again from My Machines/);
    await refusedWith(Connection.connect({ address }), /this machine is not known here/);
  }, 60_000);
});
