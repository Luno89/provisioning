import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { monitoringRouter } from './monitoring.js';
import { MonitoringService } from '../services/MonitoringService.js';
import { clusterOwnership } from '../../platform/lib/ownership.js';
import type { ClusterMetadata } from '../../platform/lib/types.js';

const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true } as ClusterMetadata;

let harness: Harness;
let ranges: string[];

beforeEach(async () => {
  ranges = [];
  harness = await mountRouter({
    prefix: '/api/monitoring',
    router: (db) => monitoringRouter({
      monitoring: new MonitoringService({
        store: db,
        systemCluster: async () => system,
        ownsCluster: clusterOwnership(TEST_USER.id),
        prometheus: async () => ({
          query: async () => [{ metric: {}, value: 1 }],
          range: async (_query, start, end) => { ranges.push(`${end - start}`); return []; },
          alerts: async () => [],
        }),
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
    const { data } = await axios.get(harness.url('/api/monitoring'));
    expect(data.apps.map((app: { name: string }) => app.name)).toEqual(['Books']);
    expect(data.clusters[0].history).toMatchObject({ days: 10, canChange: true });
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
