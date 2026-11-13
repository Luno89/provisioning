import { afterAll, describe, expect, it } from 'vitest';
import { Fence } from '../lib/fence.js';
import { testDatabase } from '../lib/test-database.js';
import { endAndDrop, FenceWatch } from './FenceWatch.js';

const started: FenceWatch[] = [];

afterAll(async () => {
  for (const watch of started) await watch.stop();
});

const leaving = { kind: 'owner', id: 'leaving' } as const;

describe('a fence kept until every process from before its removal ended has started again', () => {
  it('stays while a process live when its removal ended still runs, and goes from the store and every process once each of them has started again', async () => {
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
    expect(await db.platform.fencesRaised()).toEqual([]);
    await expect.poll(() => engineAgain.fence.holds(leaving) || hostAgain.fence.holds(leaving)).toBe(false);
  });
});
