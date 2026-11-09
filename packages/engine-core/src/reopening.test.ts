import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REOPEN_FIRST_MS, REOPEN_MOST_MS, reopening } from './reopening.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('trying again after something was lost', () => {
  it('waits 5 s, doubling each time up to a minute, and starts again from 5 s once it is back', async () => {
    const again = reopening();
    const waits: number[] = [];
    for (let tries = 0; tries < 6; tries += 1) {
      waits.push(again.seconds);
      const waited = again.after();
      await vi.advanceTimersByTimeAsync(again.seconds * 500);
      await vi.advanceTimersByTimeAsync(REOPEN_MOST_MS);
      await waited;
    }
    expect(waits).toEqual([5, 10, 20, 40, 60, 60]);
    again.reset();
    expect(again.seconds).toBe(REOPEN_FIRST_MS / 1000);
  });

  it('runs what it is handed only once the wait is over', async () => {
    const again = reopening(2_000);
    const ran = vi.fn();
    again.later(ran);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(ran).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toHaveBeenCalledOnce();
    expect(again.seconds).toBe(4);
  });

  it('hands out each wait for a caller that waits its own way', () => {
    const again = reopening();
    expect([again.take(), again.take(), again.take(), again.take(), again.take(), again.take()]).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});
