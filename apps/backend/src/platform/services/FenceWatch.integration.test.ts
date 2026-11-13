import { afterAll, describe, expect, it, vi } from 'vitest';
import { WorkStopped, withWorkFor } from '@koala/engine-core/work-for';
import { Fence, PROCESS_BEAT_MS } from '../lib/fence.js';
import { testDatabase } from '../lib/test-database.js';
import { endAndDrop, FenceWatch } from './FenceWatch.js';

const started: FenceWatch[] = [];

afterAll(async () => {
  for (const watch of started) await watch.stop();
});

const leaving = { kind: 'owner', id: 'leaving' } as const;

describe('a fence kept until every process from before its removal ended has started again', () => {
  it('stays while a process live when its removal ended still runs, goes from the store once each has started again, and is still refused by a process that held it', async () => {
    const db = await testDatabase();
    const run = async (id: string) => {
      const fence = new Fence();
      const watch = new FenceWatch({ store: db.platform, fence, process: { id, name: 'worker-engine' } });
      await watch.start();
      started.push(watch);
      return { fence, watch };
    };
    const engine = await run('engine-1');
    const host = await run('host-1');
    await db.platform.raiseFence(leaving, new Date().toISOString());
    await expect.poll(() => engine.fence.holds(leaving) && host.fence.holds(leaving)).toBe(true);

    expect(await endAndDrop({ store: db.platform }, leaving)).toEqual([]);
    expect((await db.platform.fencesRaised())[0]?.endedWith?.sort()).toEqual(['engine-1', 'host-1']);

    await engine.watch.stop();
    const engineAgain = await run('engine-2');
    expect(await db.platform.fencesRaised()).toHaveLength(1);
    expect(engineAgain.fence.holds(leaving), 'a process started since still holds it while one from before runs').toBe(true);

    await host.watch.stop();
    const hostAgain = await run('host-2');
    expect(await db.platform.fencesRaised(), 'the fence is gone from the store, so no process starting later holds it').toEqual([]);
    expect(hostAgain.fence.holds(leaving)).toBe(false);
    await expect(withWorkFor({ owner: 'leaving' }, () => engineAgain.fence.guard(async () => 'kept')), 'a process that held it keeps refusing the account\'s work while it lives').rejects.toBeInstanceOf(WorkStopped);
  });
});

describe('a process saying it is live, on Mongo', () => {
  it('beats again every beat, so a removal keeps counting it live', async () => {
    const db = await testDatabase();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let now = Date.now();
      const watch = new FenceWatch({ store: db.platform, fence: new Fence(), process: { id: 'beating-1', name: 'backend' }, now: () => now });
      await watch.start();
      started.push(watch);
      const later = now + 120_000;
      now = later;
      await vi.advanceTimersByTimeAsync(PROCESS_BEAT_MS);
      await expect.poll(() => db.platform.processesSeenSince(new Date(later - 1_000).toISOString())).toEqual([{ id: 'beating-1', name: 'backend' }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
