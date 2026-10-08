import { describe, it, expect, afterAll } from 'vitest';
import { modelsRouter } from './models.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

const asked: string[] = [];
const harness: Harness = await mountRouter({
  prefix: '/api/models',
  router: (db) => modelsRouter({
    db,
    modelService: {},
    credentialService: {},
    rateLimits: (ownerId: string) => {
      asked.push(ownerId);
      return [{ key: 'tabby', label: 'Tabby', inFlight: 1, queued: 0, totalRequests: 5, total429: 0, totalErrors: 0 }];
    },
  }),
});

afterAll(async () => { await harness.close(); });

describe('model traffic', () => {
  it('shows the person the traffic of their own models', async () => {
    const res = await fetch(harness.url('/api/models/rate-limits'));

    expect(await res.json()).toEqual({ buckets: [{ key: 'tabby', label: 'Tabby', inFlight: 1, queued: 0, totalRequests: 5, total429: 0, totalErrors: 0 }] });
    expect(asked).toEqual([TEST_USER.id]);
  });
});
