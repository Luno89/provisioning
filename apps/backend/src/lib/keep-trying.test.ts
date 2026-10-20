import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepTrying } from './keep-trying.js';

afterEach(() => { vi.useRealTimers(); });

describe('keeping on trying to reach something that is not up yet', () => {
  it('says whether the first try worked, and keeps trying until one does', async () => {
    vi.useFakeTimers();
    const said: string[] = [];
    let tries = 0;
    const first = await keepTrying('Temporal', async () => { tries += 1; if (tries < 3) throw new Error('connection refused'); }, (message) => said.push(message), 1000);
    expect(first).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries).toBe(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tries).toBe(3);
    expect(said).toEqual(['Temporal: connection refused; trying again in 1 s', 'Temporal: connection refused; trying again in 1 s']);
  });
});
