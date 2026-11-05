import http from 'node:http';
import type { AddressInfo } from 'node:net';
import protobuf from 'protobufjs';
import { compress, uncompress } from 'snappyjs';
import { afterEach, describe, expect, it } from 'vitest';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';
import { MachineMetricsRelay } from '../services/MachineMetricsRelay.js';
import { newMetricsToken } from '../lib/machine-metrics.js';
import { machinesRouter } from './machines.js';

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

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

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

async function koala(receiver: { url: string }): Promise<{ site: Harness; token: string }> {
  const { token, hash } = newMetricsToken();
  let site: Harness | undefined;
  site = await mountRouter({
    prefix: '/api/machines',
    open: true,
    db: 'own',
    router: (db) => machinesRouter({
      bundle: { path: async () => '', sha256: async () => '' },
      metrics: new MachineMetricsRelay({
        clusters: () => db.infrastructure.getClusters(),
        write: async (body) => {
          const answer = await fetch(receiver.url, { method: 'POST', body, headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy' } });
          return { status: answer.status, text: await answer.text() };
        },
      }),
    }),
  });
  closers.push(() => site!.close());
  await site.db.infrastructure.saveCluster({ id: 'machine-desk', name: 'desk', provider: 'machine', status: 'healthy', machineId: 'desk', ownerId: 'bo', metricsTokenHash: hash } as ClusterMetadata);
  await site.db.infrastructure.saveCluster({ id: 'machine-other', name: 'other', provider: 'machine', status: 'healthy', machineId: 'other', ownerId: 'cy' } as ClusterMetadata);
  return { site, token };
}

const send = (site: Harness, body: Buffer, token?: string) => fetch(site.url('/api/machines/metrics'), {
  method: 'POST', body, headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'snappy', ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

describe('a machine\'s cluster sending its metrics to its Koala', () => {
  it('reaches the instance\'s Prometheus under its own cluster, whatever cluster it named, compressed as remote write sends it', async () => {
    const receiver = await prometheusReceiver();
    const { site, token } = await koala(receiver);
    const answer = await send(site, batch([{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-other' }, { name: 'namespace', value: 'books' }]), token);
    expect(answer.status).toBe(204);
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]!.headers['content-encoding']).toBe('snappy');
    expect(labelsIn(receiver.received[0]!.body)).toEqual([[{ name: '__name__', value: 'probe_success' }, { name: 'koala_cluster', value: 'machine-desk' }, { name: 'namespace', value: 'books' }]]);
  });

  it('is refused without the cluster\'s token, with another, or as something that is not remote write, and nothing reaches Prometheus', async () => {
    const receiver = await prometheusReceiver();
    const { site, token } = await koala(receiver);
    const body = batch([{ name: '__name__', value: 'up' }]);
    expect((await send(site, body)).status).toBe(401);
    expect((await send(site, body, `${token}x`)).status).toBe(401);
    expect((await send(site, Buffer.from('not snappy'), token)).status).toBe(400);
    expect(receiver.received).toEqual([]);
  });

  it('says what Prometheus refused', async () => {
    const receiver = await prometheusReceiver(400);
    const { site, token } = await koala(receiver);
    const answer = await send(site, batch([{ name: '__name__', value: 'up' }]), token);
    expect(answer.status).toBe(400);
    expect(await answer.text()).toBe('out of order sample');
  });
});
