import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acquireModelSlot, recordModelResponse, recordModelFailure, rateLimitedFetch,
  getModelRateLimiterSnapshot,
} from './model-rate-limiter.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('acquireModelSlot concurrency', () => {
  it('serializes two acquires on the same key — the second waits for the first to release', async () => {
    const key = `serial-${Math.random()}`;
    const release1 = await acquireModelSlot(key, 'user-1', 'test');

    let acquired2 = false;
    const p2 = acquireModelSlot(key, 'user-1', 'test').then((release) => { acquired2 = true; return release; });

    await flush();
    expect(acquired2).toBe(false);

    release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    release2();
  });

  it('lets two different keys run concurrently without waiting on each other', async () => {
    const keyA = `a-${Math.random()}`;
    const keyB = `b-${Math.random()}`;
    const releaseA = await acquireModelSlot(keyA, 'user-1', 'a');

    let acquiredB = false;
    const pB = acquireModelSlot(keyB, 'user-1', 'b').then((release) => { acquiredB = true; return release; });

    await flush();
    expect(acquiredB).toBe(true);

    releaseA();
    (await pB)();
  });
});

describe('cooldown after a 429', () => {
  it('makes the next acquire on that key wait until the cooldown window passes', async () => {
    vi.useFakeTimers();
    try {
      const key = `cooldown-${Math.random()}`;
      const release1 = await acquireModelSlot(key, 'user-1', 'test');
      recordModelResponse(key, 429, new Headers({ 'retry-after': '5' }));
      release1();

      let acquired2 = false;
      const p2 = acquireModelSlot(key, 'user-1', 'test').then((release) => { acquired2 = true; return release; });

      await vi.advanceTimersByTimeAsync(1000);
      expect(acquired2).toBe(false);

      await vi.advanceTimersByTimeAsync(4500);
      expect(acquired2).toBe(true);
      (await p2)();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clamps an unreasonably long Retry-After to the configured maximum', async () => {
    vi.useFakeTimers();
    try {
      const key = `clamp-${Math.random()}`;
      const release1 = await acquireModelSlot(key, 'user-1', 'test');
      recordModelResponse(key, 429, new Headers({ 'retry-after': '99999' }));
      release1();

      let acquired2 = false;
      const p2 = acquireModelSlot(key, 'user-1', 'test').then(() => { acquired2 = true; });

      await vi.advanceTimersByTimeAsync(120_001);
      expect(acquired2).toBe(true);
      await p2;
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the default cooldown when there is no Retry-After header', async () => {
    vi.useFakeTimers();
    try {
      const key = `default-cooldown-${Math.random()}`;
      const release1 = await acquireModelSlot(key, 'user-1', 'test');
      recordModelResponse(key, 429);
      release1();

      let acquired2 = false;
      const p2 = acquireModelSlot(key, 'user-1', 'test').then(() => { acquired2 = true; });

      await vi.advanceTimersByTimeAsync(19_000);
      expect(acquired2).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(acquired2).toBe(true);
      await p2;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cool down on a non-429 response', async () => {
    const key = `ok-${Math.random()}`;
    const release1 = await acquireModelSlot(key, 'user-1', 'test');
    recordModelResponse(key, 200);
    release1();

    let acquired2 = false;
    const p2 = acquireModelSlot(key, 'user-1', 'test').then((release) => { acquired2 = true; return release; });
    await flush();
    expect(acquired2).toBe(true);
    (await p2)();
  });
});

describe('queue timeout', () => {
  it('rejects a request that waits longer than the max queue window instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      const key = `stuck-${Math.random()}`;
      await acquireModelSlot(key, 'user-1', 'test');

      const p2 = acquireModelSlot(key, 'user-1', 'test');
      const assertion = expect(p2).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(8 * 60_000 + 1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimitedFetch', () => {
  it('passes through untouched when no key is given (self-hosted deployments)', async () => {
    const impl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const wrapped = rateLimitedFetch(undefined, 'user-1', 'label', impl as unknown as typeof fetch);
    expect(wrapped).toBe(impl);
  });

  it('records the response status and releases the slot even on success', async () => {
    const key = `wrap-${Math.random()}`;
    const impl = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const wrapped = rateLimitedFetch(key, 'user-1', 'label', impl as unknown as typeof fetch);

    await wrapped('https://example.com', {});
    const [snap] = getModelRateLimiterSnapshot('user-1').filter((b) => b.key === key);
    expect(snap?.totalRequests).toBe(1);
    expect(snap?.inFlight).toBe(0);
  });

  it('records a failure and still releases the slot when the fetch throws', async () => {
    const key = `wrap-throw-${Math.random()}`;
    const impl = vi.fn().mockRejectedValue(new Error('network down'));
    const wrapped = rateLimitedFetch(key, 'user-1', 'label', impl as unknown as typeof fetch);

    await expect(wrapped('https://example.com', {})).rejects.toThrow('network down');
    const [snap] = getModelRateLimiterSnapshot('user-1').filter((b) => b.key === key);
    expect(snap?.totalErrors).toBe(1);
    expect(snap?.inFlight).toBe(0);
  });
});

describe('getModelRateLimiterSnapshot', () => {
  it('only returns buckets belonging to the requesting owner', async () => {
    const keyMine = `mine-${Math.random()}`;
    const keyTheirs = `theirs-${Math.random()}`;
    (await acquireModelSlot(keyMine, 'owner-a', 'mine'))();
    (await acquireModelSlot(keyTheirs, 'owner-b', 'theirs'))();

    const mine = getModelRateLimiterSnapshot('owner-a');
    expect(mine.some((b) => b.key === keyMine)).toBe(true);
    expect(mine.some((b) => b.key === keyTheirs)).toBe(false);
  });
});
