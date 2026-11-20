import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { BlobReach } from '@koala/engine-core/payloads';
import { connectTemporal, createClient, createWorker } from '@koala/engine-core/temporal';
import { bundled, temporalTestEnvironment, type TestTemporal } from '../../workflows/testing/temporal-test-env.js';
import { testPayloadBlobs } from '../../platform/lib/test-database.js';
import { MachineTemporalGateway } from './MachineTemporalGateway.js';
import { temporalApiKey, temporalJwks } from '../../platform/lib/temporal-auth.js';
import { askMachine } from '../testing/MachineTemporalGateway.fixture-workflow.js';
import { testWorker } from '../../workflows/testing/test-worker.js';

let env: TestTemporal;
let gateway: MachineTemporalGateway;
let address = '';
const refusals: string[] = [];
const { blobs, stored } = testPayloadBlobs();
const PAYLOAD_KEY = 'p'.repeat(64);
const TEMPORAL_KEY = 'machine-gateway-temporal-key';
const handedBlobs = new Set<string>();
const upstreamAuth: (string | undefined)[] = [];
let relay: http2.Http2Server;
let relayed: http2.ClientHttp2Session;
const TLS_DIR = dirname(inject('temporalCa'));
const CA = readFileSync(join(TLS_DIR, 'ca.crt'));
const overTls = { serverRootCACertificate: CA, serverNameOverride: 'temporal' };

const withoutPseudo = (headers: http2.IncomingHttpHeaders, keep: string[] = []) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(':') || keep.includes(name)));

async function recordingRelay(to: string): Promise<string> {
  relayed = http2.connect(`http://${to}`);
  relay = http2.createServer();
  relay.on('stream', (stream, headers) => {
    upstreamAuth.push(headers.authorization);
    const up = relayed.request(withoutPseudo(headers, [':method', ':path']));
    let trailers: http2.OutgoingHttpHeaders = {};
    up.on('trailers', (ended: http2.IncomingHttpHeaders) => { trailers = withoutPseudo(ended); });
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
    upstreamKey: temporalApiKey(TEMPORAL_KEY, { subject: 'koala-machine-gateway', namespace: env.namespace ?? 'default', role: 'write' }),
    namespace: env.namespace ?? 'default',
    keys: () => ['the-key'],
    deviceOf: async (token) => ({ 'token-d1': { id: 'd1' }, 'token-d2': { id: 'd2' } } as Record<string, { id: string }>)[token],
    handed: async (workflowId, deviceId) => {
      for (const blob of await stored()) if (blob.workflowId === workflowId) handedBlobs.add(blob.id);
      await blobs.handTo(workflowId, deviceId);
    },
    log: (line) => refusals.push(line),
    tls: { cert: readFileSync(join(TLS_DIR, 'server.crt')), key: readFileSync(join(TLS_DIR, 'server.key')) },
  });
  address = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
});

afterAll(async () => {
  await gateway?.close();
  relayed?.close();
  await new Promise((done) => (relay ? relay.close(done) : done(undefined)));
  await env?.teardown();
});

const asMachine = (token: string) => connectTemporal({ address, tls: { ca: CA, serverName: 'temporal' }, auth: { bearer: token } }, 'worker');

const refusedWith = async (attempt: Promise<unknown>, said: RegExp) => {
  const err = await attempt.then(() => undefined, (failure: unknown) => failure);
  const chain: string[] = [];
  for (let at = err as { message?: string; details?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) chain.push(at.details ?? '', at.message ?? '');
  expect(chain.join(' | ')).toMatch(said);
};

describe('a machine reaching Temporal through the gateway', () => {
  it('takes its own work, heartbeats and answers it, as if it spoke to Temporal itself', async () => {
    const machine = await createWorker({
      connection: await asMachine('token-d1'),
      namespace: env.namespace ?? 'default',
      taskQueue: 'device-d1',
      payloads: env.payloads,
      activities: { Echo: async (text: string) => { Context.current().heartbeat(); return `machine says ${text}`; } },
    });
    const workflows = await testWorker(env, { namespace: env.namespace ?? 'default', taskQueue: 'gateway-test', workflowBundle: await bundled(resolve(__dirname, '../testing/MachineTemporalGateway.fixture-workflow.ts')) });
    const answer = await workflows.runUntil(machine.runUntil(env.client.workflow.execute(askMachine, { taskQueue: 'gateway-test', workflowId: `ask-${Date.now()}`, args: ['d1', 'hello'] })));
    expect(answer).toBe('machine says hello');
  });

  it('lets a machine read the large payloads of the tasks it was handed, and no other machine', async () => {
    const machine = await createWorker({
      connection: await asMachine('token-d1'),
      namespace: env.namespace ?? 'default',
      taskQueue: 'device-d1',
      payloads: { ring: PAYLOAD_KEY, blobs: asDevice('d1') },
      activities: { Echo: async (text: string) => `machine says ${text}` },
    });
    const payloads = { ring: PAYLOAD_KEY, blobs };
    const workflows = await createWorker({ connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue: 'gateway-big', payloads, workflowBundle: await bundled(resolve(__dirname, '../testing/MachineTemporalGateway.fixture-workflow.ts')) });
    const client = createClient({ connection: env.connection, namespace: env.namespace ?? 'default', payloads });
    const pasted = 'a'.repeat(100) + Buffer.alloc(200_000).map(() => Math.floor(Math.random() * 26) + 97).toString();
    const before = new Set((await stored()).map((blob) => blob.id));
    const answer = await workflows.runUntil(machine.runUntil(client.workflow.execute(askMachine, { taskQueue: 'gateway-big', workflowId: `big-${Date.now()}`, args: ['d1', pasted] })));
    expect(answer).toBe(`machine says ${pasted}`);
    const offloaded = (await stored()).map((blob) => blob.id).filter((id) => !before.has(id));
    const itsOwn = offloaded.filter((id) => handedBlobs.has(id));
    expect(itsOwn.length).toBeGreaterThanOrEqual(2);
    expect(itsOwn.length).toBeLessThan(offloaded.length);
    expect([...(await blobs.getHanded('d1', offloaded)).keys()].sort()).toEqual(itsOwn.sort());
    expect((await blobs.getHanded('d2', offloaded)).size).toBe(0);
  });

  it('speaks to Temporal with its own token for its one role on the namespace, signed by the install\'s Temporal key, never the machine\'s', () => {
    expect(upstreamAuth.length).toBeGreaterThan(0);
    const tokens = new Set(upstreamAuth.map((auth) => String(auth).replace(/^Bearer /, '')));
    expect(tokens.size).toBe(1);
    const [head, body, signature] = [...tokens][0]!.split('.');
    const verifier = crypto.createPublicKey({ key: { ...temporalJwks(TEMPORAL_KEY).keys[0]! } as crypto.JsonWebKey, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${head}.${body}`), { key: verifier, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'))).toMatchObject({ sub: 'koala-machine-gateway', permissions: [`${env.namespace ?? 'default'}:write`] });
  });

  it('never lets a machine take another machine\'s work', async () => {
    const thief = await createWorker({ connection: await asMachine('token-d2'), namespace: env.namespace ?? 'default', taskQueue: 'device-d1', payloads: env.payloads, activities: { Echo: async () => 'stolen' } });
    await thief.runUntil(new Promise((done) => setTimeout(done, 3_000)));
    expect(refusals.some((line) => line.includes('refused PollActivityTaskQueue from d2: a machine takes work only from its own queue, device-d2'))).toBe(true);
  });

  it('refuses everything else a machine might ask, and anyone without a machine\'s token', async () => {
    const client = new Client({ connection: await Connection.connect({ address, tls: overTls, metadata: { authorization: 'Bearer token-d1' } }), namespace: env.namespace ?? 'default' });
    await refusedWith(client.workflow.list()[Symbol.asyncIterator]().next(), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.start('askMachine', { taskQueue: 'gateway-test', workflowId: 'not-allowed', args: ['d1', 'x'] }), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.getHandle('anything').signal('cancelRun'), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.activity.complete(Buffer.from('a-forged-task-token'), 'done'), /tasks it was handed|PERMISSION_DENIED/);
    await refusedWith(Connection.connect({ address, tls: overTls, metadata: { authorization: 'Bearer not-a-machine' } }), /this machine is not known here; add it again from My Machines/);
    await refusedWith(Connection.connect({ address, tls: overTls }), /this machine is not known here/);
  });

  it('answers a machine only over TLS, refusing one that speaks to it in plaintext', async () => {
    await expect(NativeConnection.connect({ address, metadata: { authorization: 'Bearer token-d1' } })).rejects.toThrow();
    const plain = http2.connect(`http://${address}`);
    const failed = await new Promise<string>((done) => { plain.once('error', (err: Error) => done(err.message)); plain.once('close', () => done('closed')); plain.once('connect', () => { const asked = plain.request({ ':path': '/temporal.api.workflowservice.v1.WorkflowService/GetSystemInfo' }); asked.once('response', () => done('answered')); asked.once('error', (err: Error) => done(err.message)); asked.end(); }); });
    plain.destroy();
    expect(failed).not.toBe('answered');
  });
});
