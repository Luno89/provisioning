import { describe, expect, it } from 'vitest';
import { withWorkFor } from '@koala/engine-core/work-for';
import { MemoryPlatformStore } from '../testing/memory-store.js';
import { Fence } from '../lib/fence.js';
import { FenceWatch, fenceHeldEverywhere } from './FenceWatch.js';

const leaving = { kind: 'owner', id: 'leaving' } as const;
const NOW = Date.parse('2026-11-13T10:00:00.000Z');

describe('each process holding the fences removals raise', () => {
  it('holds every fence raised before it started, and gives its word only for those not yet confirmed', async () => {
    const store = new MemoryPlatformStore();
    await store.raiseFence(leaving, '2026-11-13T09:00:00.000Z');
    await store.raiseFence({ kind: 'owner', id: 'gone' }, '2026-11-13T08:00:00.000Z');
    await store.confirmFence({ kind: 'owner', id: 'gone' });
    const fence = new Fence();
    const watch = new FenceWatch({ store, fence, process: { id: 'engine-1', name: 'worker-engine' }, now: () => NOW });
    await watch.start();
    expect(fence.holds(leaving)).toBe(true);
    expect(fence.holds({ kind: 'owner', id: 'gone' })).toBe(true);
    expect(await store.fenceAcks(leaving)).toEqual(['engine-1']);
    expect(await store.fenceAcks({ kind: 'owner', id: 'gone' })).toEqual([]);
    expect(await store.processesSeenSince('2026-11-13T09:59:59.000Z')).toEqual([{ id: 'engine-1', name: 'worker-engine' }]);
    await watch.stop();
    expect(await store.processesSeenSince('2026-11-13T09:00:00.000Z')).toEqual([]);
  });

  it('holds a fence raised while it runs, and gives its word only once the work for it that got past the fence has finished', async () => {
    const store = new MemoryPlatformStore();
    const fence = new Fence();
    const watch = new FenceWatch({ store, fence, process: { id: 'engine-1', name: 'worker-engine' }, now: () => NOW });
    await watch.start();
    let finish!: () => void;
    const inFlight = withWorkFor({ owner: 'leaving' }, () => fence.guard(() => new Promise<void>((resolve) => { finish = resolve; })));
    let acked!: () => void;
    const heard = new Promise<void>((resolve) => { acked = resolve; });
    store.watchFenceAcks(() => acked());
    await store.raiseFence(leaving, '2026-11-13T10:00:00.000Z');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fence.holds(leaving)).toBe(true);
    expect(await store.fenceAcks(leaving)).toEqual([]);
    finish();
    await inFlight;
    await heard;
    expect(await store.fenceAcks(leaving)).toEqual(['engine-1']);
    await watch.stop();
  });
});

describe('a removal waiting until every process holds its fence', () => {
  it('goes on once every live process has given its word, waiting on no process whose beats stopped', async () => {
    const store = new MemoryPlatformStore();
    await store.raiseFence(leaving, '2026-11-13T10:00:00.000Z');
    await store.beatProcess({ id: 'engine-1', name: 'worker-engine' }, '2026-11-13T10:00:00.000Z');
    await store.beatProcess({ id: 'backend-1', name: 'backend' }, '2026-11-13T09:59:50.000Z');
    await store.beatProcess({ id: 'old-host', name: 'worker-host' }, '2026-11-13T09:50:00.000Z');
    let done = false;
    const held = fenceHeldEverywhere({ store, now: () => NOW }, leaving).then((by) => { done = true; return by; });
    await store.ackFence(leaving, 'engine-1', '2026-11-13T10:00:01.000Z');
    await new Promise((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    await store.ackFence(leaving, 'backend-1', '2026-11-13T10:00:02.000Z');
    expect((await held).sort()).toEqual(['backend-1', 'engine-1']);
  });

  it('goes on at once when every live process already gave its word, or none runs', async () => {
    const store = new MemoryPlatformStore();
    await store.raiseFence(leaving, '2026-11-13T10:00:00.000Z');
    expect(await fenceHeldEverywhere({ store, now: () => NOW }, leaving)).toEqual([]);
  });
});
