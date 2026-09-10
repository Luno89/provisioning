import { describe, it, expect, afterAll } from 'vitest';
import { rateLimitsRouter } from './rate-limits.js';
import { mountRouter, type Harness, TEST_USER } from '../test-harness.js';
import type { Database } from '../../lib/db-interface.js';
import { acquireModelSlot, recordModelResponse } from '../../lib/model-rate-limiter.js';

const harness: Harness = await mountRouter({
  prefix: '/api/harness/rate-limits',
  router: (_db: Database) => rateLimitsRouter(),
});

afterAll(async () => { await harness.close(); });

describe('GET /api/harness/rate-limits', () => {
  it('returns only the requesting user\'s own buckets', async () => {
    const mineKey = `mine-${Math.random()}`;
    const theirsKey = `theirs-${Math.random()}`;

    const releaseMine = await acquireModelSlot(mineKey, TEST_USER.id, 'OpenRouter · openrouter/free');
    recordModelResponse(mineKey, 429, new Headers({ 'retry-after': '30' }));
    releaseMine();

    (await acquireModelSlot(theirsKey, 'someone-else', 'Their endpoint'))();

    const res = await fetch(harness.url('/api/harness/rate-limits'));
    expect(res.status).toBe(200);
    const body = await res.json() as any[];

    expect(body.some((b) => b.key === mineKey)).toBe(true);
    expect(body.some((b) => b.key === theirsKey)).toBe(false);

    const mine = body.find((b) => b.key === mineKey);
    expect(mine.label).toBe('OpenRouter · openrouter/free');
    expect(mine.total429).toBe(1);
    expect(mine.cooldownUntil).toBeTruthy();
    expect(mine.ownerId).toBeUndefined();
  });
});
