import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import protobuf from 'protobufjs';
import { compress, uncompress } from 'snappyjs';
import { describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { generateIdentityKey, identityKeysFrom } from '../../instances/lib/identity-token.js';
import { machineAccessAt, machineAccessCheckedAt, machineMetricsClient, machineSignInKey, metricsAccessAt } from '../../instances/testing/registration-code.js';
import { MachineMetricsRelay } from '../services/MachineMetricsRelay.js';
import { metricsAdmission } from '../wiring/machine-admission.js';
import { machinesRouter } from './machines.js';
import { closedAfterEach } from '../testing/wiring-world.js';

const WriteRequest = protobuf.parse(`
syntax = "proto3";
message WriteRequest { repeated TimeSeries timeseries = 1; }
message TimeSeries { repeated Label labels = 1; repeated Sample samples = 2; }
message Label { string name = 1; string value = 2; }
message Sample { double value = 1; int64 timestamp = 2; }
`).root.lookupType('WriteRequest');

type Labels = Array<{ name: string; value: string }>;
const batch = (labels: Labels) => Buffer.from(compress(WriteRequest.encode(WriteRequest.fromObject({ timeseries: [{ labels, samples: [{ value: 1, timestamp: 1_793_000_000_000 }] }] })).finish()));
const labelsIn = (body: Buffer) => (WriteRequest.toObject(WriteRequest.decode(Buffer.from(uncompress(body)))) as { timeseries: Array<{ labels: Labels }> }).timeseries.map((series) => series.labels);

const closers = closedAfterEach();
const ROOT = { url: 'http://127.0.0.1:1', signing: identityKeysFrom(generateIdentityKey()) };
const KOALA = 'inst-1';

async function prometheusReceiver(status = 204) {
  const received: Array<{ body: Buffer; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => { received.push({ body: Buffer.concat(chunks), headers: req.headers }); res.writeHead(status).end(status < 300 ? '' : 'out of order sample'); });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  closers.push(() => new Promise<void>((done) => { server.close(() => done()); }));
  return { received, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/write` };
}

const machineOf = (db: Database, id: string, ownerId: string, koala: string) => Promise.all([
  db.machines.saveLocalAgentDevice({ id, ownerId, name: id, rootDir: '/home/person/koala', createdAt: new Date().toISOString(), signIn: machineSignInKey(), metricsClient: machineMetricsClient() }),
  db.instances.saveInstance({ id: koala, ownerId, url: `http://${koala}.test`, createdAt: 'then', updatedAt: 'then', status: 'ready' }),
]);

async function koala(receiver: { url: string }) {
  const clock = { now: Date.now() };
  let site: Harness | undefined;
  site = await mountRouter({
    prefix: '/api/machines',
    open: true,
    db: 'own',
    router: (db) => machinesRouter({
      bundle: { path: async () => '', sha256: async () => '' },
      metrics: new MachineMetricsRelay({
        admit: metricsAdmission(db, machineAccessCheckedAt(ROOT, KOALA, () => clock.now), 'bo'),
        write: async (body) => {
          const answer = await fetch(receiver.url, { method: 'POST', body, headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy' } });
          return { status: answer.status, text: await answer.text() };
        },
      }),
    }),
  });
  closers.push(() => site!.close());
  await machineOf(site.db, 'desk', 'bo', KOALA);
  await machineOf(site.db, 'other', 'cy', 'inst-2');
  return { site, clock, token: () => metricsAccessAt(site!.db, ROOT, { deviceId: 'desk', koala: KOALA }) };
}

const send = (site: Harness, body: Buffer, token?: string) => fetch(site.url('/api/machines/metrics'), {
  method: 'POST', body, headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

describe('a machine\'s cluster sending its metrics to its Koala', () => {
  it('reaches the instance\'s Prometheus under its own cluster, whatever cluster it named, compressed as remote write sends it, with the token root gave its Prometheus', async () => {
    const receiver = await prometheusReceiver();
    const { site, token } = await koala(receiver);
    const answer = await send(site, batch([{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-other' }, { name: 'namespace', value: 'books' }]), await token());
    expect(answer.status).toBe(204);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.headers['content-encoding']).toBe('snappy');
    expect(labelsIn(receiver.received[0]!.body)).toEqual([[{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-desk' }, { name: 'namespace', value: 'books' }]]);
  });

  it('is refused without a token, with a fixed token like the one clusters kept, with root\'s token for another Koala, with one that ran out, and with the machine agent\'s own token, and nothing reaches Prometheus', async () => {
    const receiver = await prometheusReceiver();
    const { site, clock, token } = await koala(receiver);
    const body = batch([{ name: '__name__', value: 'up' }]);
    expect((await send(site, body)).status).toBe(401);
    expect((await send(site, body, randomBytes(32).toString('base64url'))).status).toBe(401);
    const elsewhere = await send(site, body, await metricsAccessAt(site.db, ROOT, { deviceId: 'other', koala: 'inst-2' }));
    expect([elsewhere.status, await elsewhere.text()]).toEqual([401, expect.stringMatching(/aud/)]);
    const agents = await send(site, body, await machineAccessAt(site.db, ROOT, { deviceId: 'desk', koala: KOALA }));
    expect([agents.status, await agents.text()]).toEqual([401, expect.stringMatching(/Prometheus/)]);
    const fresh = await token();
    clock.now += 6 * 60 * 1000;
    const late = await send(site, body, fresh);
    expect([late.status, await late.text()]).toEqual([401, expect.stringMatching(/exp/)]);
    expect(receiver.received).toEqual([]);
  });

  it('is refused something that is not remote write, and says what Prometheus refused', async () => {
    const refusing = await prometheusReceiver(400);
    const { site, token } = await koala(refusing);
    expect((await send(site, Buffer.from('not snappy'), await token())).status).toBe(400);
    const answer = await send(site, batch([{ name: '__name__', value: 'up' }]), await token());
    expect(answer.status).toBe(400);
    expect(await answer.text()).toBe('out of order sample');
  });
});
