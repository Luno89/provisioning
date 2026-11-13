import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server } from 'node:http';
import { drainThenStop } from '../services/drain.js';
import { stopBackend } from './shutdown.js';

vi.mock('../services/drain.js', () => ({ drainThenStop: vi.fn() }));

const drained = vi.mocked(drainThenStop);
const place = { ip: '10.42.0.9', namespace: 'nowrinkles' };
const drain = (inPod: boolean) => ({ place: inPod ? place : undefined, server: mock<Server>(), sockets: { disconnectSockets: () => undefined }, log: () => undefined });

beforeEach(() => { drained.mockReset(); });

describe('the backend stopping cleanly', () => {
  it('stops what it runs, drains in a pod, then takes itself off the live list before it exits, so a fence stops waiting on it at once', async () => {
    const order: string[] = [];
    drained.mockImplementation(async () => { order.push('drain'); });
    await stopBackend({
      stopping: () => { order.push('stop'); },
      drain: drain(true),
      fences: { stop: async () => { order.push('let go of fences'); } },
      exit: (code) => { order.push(`exit ${code}`); },
    });
    expect(order).toEqual(['stop', 'drain', 'let go of fences', 'exit 0']);
  });

  it('drains nothing outside a pod, and still takes itself off the live list when the drain fails, exiting with how it went', async () => {
    const exits: number[] = [];
    const fences = { stop: vi.fn(async () => undefined) };
    await stopBackend({ stopping: () => undefined, drain: drain(false), fences, exit: (code) => { exits.push(code); } });
    expect(drained).not.toHaveBeenCalled();
    drained.mockRejectedValue(new Error('the slices could not be read'));
    await stopBackend({ stopping: () => undefined, drain: drain(true), fences, exit: (code) => { exits.push(code); } });
    expect(fences.stop).toHaveBeenCalledTimes(2);
    expect(exits).toEqual([0, 1]);
  });

  it('exits even when it cannot take itself off the live list, whose beats then simply stop', async () => {
    const exits: number[] = [];
    await stopBackend({ stopping: () => undefined, drain: drain(false), fences: { stop: async () => { throw new Error('Mongo is away'); } }, exit: (code) => { exits.push(code); } });
    expect(exits).toEqual([0]);
  });
});
