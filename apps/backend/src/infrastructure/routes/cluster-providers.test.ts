import type { Router } from 'express';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { seedClusterProviders } from '../lib/cluster-providers.js';
import { clusterProvidersRouter } from './cluster-providers.js';
import { PERSON, routesInProcess } from '../../platform/testing/routes.js';

const on = (router: Router) => routesInProcess({ prefix: '/api/cluster-providers', router: () => router, user: PERSON });

describe('/api/cluster-providers', () => {
  it('offers the providers Koala makes a cluster on, and not the ones that are not built', async () => {
    const db = memoryDatabase();
    await seedClusterProviders(db.infrastructure);
    const answer = await (await on(clusterProvidersRouter({ db }))).get('/api/cluster-providers');
    expect(answer.status).toBe(200);
    const values = (answer.data as { value: string }[]).map((provider) => provider.value);
    expect(values).toContain('k3d');
    expect(values).not.toContain('aws');
  });
});
