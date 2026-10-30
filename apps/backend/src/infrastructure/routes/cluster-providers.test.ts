import { describe, it, expect, afterAll } from 'vitest';
import { clusterProvidersRouter } from './cluster-providers.js';
import { mountRouter, type Harness } from '../../platform/routes/test-harness.js';
import { BUILT_IN_PROVIDERS } from '../lib/cluster-providers.js';

const harness: Harness = await mountRouter({
  prefix: '/api/cluster-providers',
  router: (db) => clusterProvidersRouter({ db }),
});

afterAll(async () => {
  await harness.close();
});

describe('GET /api/cluster-providers', () => {
  it('serves an empty list when nothing is seeded yet', async () => {
    const res = await fetch(harness.url('/api/cluster-providers'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('serves seeded providers after they are stored', async () => {
    for (const p of BUILT_IN_PROVIDERS) {
      await harness.db.infrastructure.saveClusterProvider(p);
    }

    const res = await fetch(harness.url('/api/cluster-providers'));
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((p) => p.value).sort()).toEqual(['do', 'hetzner', 'k3d', 'remote']);
    const hetzner = body.find((p) => p.value === 'hetzner');
    expect(hetzner?.hasCatalog).toBe(true);
  });

  it('never offers a provider Koala cannot make a cluster on yet, even one stored in the catalogue', async () => {
    await harness.db.infrastructure.saveClusterProvider({ value: 'aws', label: 'Amazon EKS', credentialKey: 'aws', hasCatalog: false, usesMesh: false });
    const body = (await (await fetch(harness.url('/api/cluster-providers'))).json()) as Array<Record<string, unknown>>;
    expect(body.map((p) => p.value)).not.toContain('aws');
  });
});
