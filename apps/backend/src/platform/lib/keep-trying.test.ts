import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepTrying } from './keep-trying.js';

afterEach(() => { vi.useRealTimers(); });

describe('keeping on trying to reach something that is not up yet', () => {
  it('says whether the first try worked, and keeps trying, 5 s doubling to a minute, until one does', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let tries = 0;
    const first = await keepTrying('Temporal', async () => { tries += 1; if (tries < 4) throw new Error('connection refused'); }, (message) => said.push(message));
    expect(first).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(3);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(tries).toBe(4);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(tries).toBe(4);
    expect(said).toEqual([
      'Temporal: connection refused; trying again in 5 s',
      'Temporal: connection refused; trying again in 10 s',
      'Temporal: connection refused; trying again in 20 s',
    ]);
  });
});
