import { describe, expect, it, vi } from 'vitest';
import { stopBackend } from './shutdown.js';

describe('the backend stopping cleanly', () => {
  it('stops what it runs, drains, then takes itself off the live list before it exits, so a fence stops waiting on it at once', async () => {
    const order: string[] = [];
    await stopBackend({
      stopping: () => { order.push('stop'); },
      drain: async () => { order.push('drain'); },
      fences: { stop: async () => { order.push('let go of fences'); } },
      exit: (code) => { order.push(`exit ${code}`); },
    });
    expect(order).toEqual(['stop', 'drain', 'let go of fences', 'exit 0']);
  });

  it('still takes itself off the live list when there is nothing to drain or the drain fails, exiting with how it went', async () => {
    const exits: number[] = [];
    const fences = { stop: vi.fn(async () => undefined) };
    await stopBackend({ stopping: () => undefined, fences, exit: (code) => { exits.push(code); } });
    await stopBackend({ stopping: () => undefined, drain: async () => { throw new Error('the slices could not be read'); }, fences, exit: (code) => { exits.push(code); }, log: () => undefined });
    expect(fences.stop).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([0, 1]);
  });

  it('exits even when it cannot take itself off the live list, whose beats then simply stop', async () => {
    const exits: number[] = [];
    await stopBackend({ stopping: () => undefined, fences: { stop: async () => { throw new Error('Mongo is away'); } }, exit: (code) => { exits.push(code); } });
    expect(exits).toEqual([0]);
  });
});
