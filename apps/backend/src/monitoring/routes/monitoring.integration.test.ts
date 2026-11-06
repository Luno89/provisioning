import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { monitoringRouter } from './monitoring.js';
import { MonitoringService, prometheusAt } from '../services/MonitoringService.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';

const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;

let harness: Harness;
let ranges: string[] = [];
let prometheus: http.Server;
let prometheusUrl: string;

const answer = (response: http.ServerResponse, data: unknown) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ status: 'success', data }));
};

beforeAll(async () => {
  prometheus = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://prometheus.test');
    if (url.pathname === '/api/v1/query') return answer(response, { resultType: 'vector', result: [{ metric: {}, value: [Date.now() / 1000, '1'] }] });
    if (url.pathname === '/api/v1/query_range') {
      ranges.push(`${Number(url.searchParams.get('end')) - Number(url.searchParams.get('start'))}`);
      return answer(response, { resultType: 'matrix', result: [] });
    }
    if (url.pathname === '/api/v1/alerts') return answer(response, { alerts: [] });
    response.statusCode = 404;
    return answer(response, null);
  });
  await new Promise<void>((done) => prometheus.listen(0, '127.0.0.1', done));
  prometheusUrl = `http://127.0.0.1:${(prometheus.address() as AddressInfo).port}`;
});

afterAll(async () => { await new Promise<void>((done) => prometheus.close(() => done())); });

beforeEach(async () => {
  ranges = [];
  harness = await mountRouter({
    prefix: '/api/monitoring',
    claims: { role: 'instance', instanceOwnerId: TEST_USER.id },
    router: (db) => monitoringRouter({
      monitoring: new MonitoringService({
        store: db,
        systemCluster: async () => system,
        prometheus: async () => prometheusAt(prometheusUrl),
        kubectl: async () => JSON.stringify({ spec: { retention: '10d' } }),
        apply: async () => {},
        helm: async () => JSON.stringify([{ name: 'kube-prometheus-stack', chart: 'kube-prometheus-stack-79.1.0' }]),
      }),
    }),
  });
  await harness.db.infrastructure.saveDeploymentInfo({ id: 'books', name: 'Books', namespace: 'books', clusterId: system.id, strategy: 'native', ownerId: TEST_USER.id, status: 'running', createdAt: 'then' });
});

afterEach(async () => { await harness.close(); });

describe('/api/monitoring', () => {
  it('gives the overview', async () => {
    const { data } = await axios.get<{ apps: Array<{ name: string }>; clusters: Array<{ history: unknown }> }>(harness.url('/api/monitoring'));
    expect(data.apps.map((app: { name: string }) => app.name)).toEqual(['Books']);
    expect(data.clusters[0]!.history).toMatchObject({ days: 10, can: ['change'] });
  });

  it('gives an app\'s health over the range asked, 24 hours otherwise', async () => {
    await axios.get(harness.url('/api/monitoring/apps/books?range=7d'));
    await axios.get(harness.url('/api/monitoring/apps/books?range=forever'));
    expect(new Set(ranges)).toEqual(new Set(['604800', '86400']));
  });

  it('answers 404 for an app that is not the person\'s and 400 for bad days', async () => {
    await expect(axios.get(harness.url('/api/monitoring/apps/nope'))).rejects.toMatchObject({ response: { status: 404 } });
    await expect(axios.put(harness.url(`/api/monitoring/clusters/${system.id}/history`), { days: 'ten' })).rejects.toMatchObject({ response: { status: 400, data: { error: 'days is a whole number' } } });
  });
});
