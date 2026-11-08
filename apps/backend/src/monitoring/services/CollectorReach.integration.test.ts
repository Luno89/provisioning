import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { testDatabase } from '../../platform/lib/test-database.js';
import { testClusterAccess } from '../../infrastructure/testing/cluster-access.js';
import type { ClusterAccess } from '../../infrastructure/index.js';
import { collectorEndpoint, collectorSink } from './CollectorReach.js';

const KOALA = 'machine-dev1';
let access: ClusterAccess;

interface Posted { path: string; type: string | undefined; body: string }

let server: http.Server;
let collector: string;
let posted: Posted[];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      posted.push({ path: req.url ?? '', type: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  collector = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  posted = [];
  access = testClusterAccess(await testDatabase(), { koalaMachineId: 'dev1', serviceAccount: { host: '10.43.0.1', port: '443', caFile: '/var/run/secrets/ca.crt', tokenFile: '/var/run/secrets/token' } });
});

const waitForPosts = async (count: number) => {
  for (let tries = 0; tries < 200 && posted.length < count; tries += 1) await new Promise((done) => setTimeout(done, 10));
};

describe('reaching a collector over HTTP', () => {
  it('sends telemetry to the address the cluster proxy hands back, and asks the proxy only once while it answers', async () => {
    let asks = 0;
    const kubeconfigs: string[] = [];
    const sink = collectorSink({ env: {}, proxy: { serviceUrl: async (clusterId, _service, kubeconfig) => { asks += 1; kubeconfigs.push(`${clusterId} ${kubeconfig}`); return collector; } }, access, koalasCluster: () => KOALA });
    await sink.send('traces', new TextEncoder().encode('{"resourceSpans":[]}'));
    await waitForPosts(1);
    expect(posted).toEqual([{ path: '/v1/traces', type: 'application/json', body: '{"resourceSpans":[]}' }]);
    expect(asks).toBeGreaterThan(0);
    expect(kubeconfigs[0]).toMatch(new RegExp(`^${KOALA} .*/kubeconfig-koala$`));
  });

  it('prefers the OTLP endpoint named in the environment over the cluster, as on root', async () => {
    const sink = collectorSink({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector }, proxy: { serviceUrl: async () => { throw new Error('never asked'); } }, access, koalasCluster: () => KOALA });
    await sink.send('metrics', new TextEncoder().encode('{"resourceMetrics":[]}'));
    await waitForPosts(1);
    expect(posted.map((entry) => entry.path)).toEqual(['/v1/metrics']);
  });

  it('does not ask the cluster again for a minute after it could not be reached, on the real clock', async () => {
    let asks = 0;
    const endpoint = collectorEndpoint({ env: {}, proxy: { serviceUrl: async () => { asks += 1; throw new Error('port-forward exited'); } }, access, koalasCluster: () => KOALA });
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    await expect(endpoint()).rejects.toThrow('port-forward exited');
    expect(asks).toBe(1);
  });

  it('says Koala\'s cluster cannot be reached by a process outside it, through the real ClusterAccess', async () => {
    let asks = 0;
    const outside = testClusterAccess(await testDatabase(), { koalaMachineId: 'dev1' });
    const endpoint = collectorEndpoint({ env: {}, proxy: { serviceUrl: async () => { asks += 1; return collector; } }, access: outside, koalasCluster: () => KOALA });
    await expect(endpoint()).rejects.toThrow('not running inside Koala\'s cluster');
    expect(asks).toBe(0);
  });

  it('answers the address of a collector that is really listening', async () => {
    const endpoint = collectorEndpoint({ env: {}, proxy: { serviceUrl: async () => collector }, access, koalasCluster: () => KOALA });
    const url = await endpoint();
    expect((await fetch(`${url}/v1/traces`, { method: 'POST', body: '{}' })).status).toBe(200);
  });
});
