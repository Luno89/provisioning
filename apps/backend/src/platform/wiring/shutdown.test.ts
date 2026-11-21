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
  it('stops what it runs, drains in a pod, then exits', async () => {
    const order: string[] = [];
    drained.mockImplementation(async () => { order.push('drain'); });
    await stopBackend({
      stopping: () => { order.push('stop'); },
      drain: drain(true),
      exit: (code) => { order.push(`exit ${code}`); },
    });
    expect(order).toEqual(['stop', 'drain', 'exit 0']);
  });

  it('drains nothing outside a pod, and exits with how the drain went', async () => {
    const exits: number[] = [];
    await stopBackend({ stopping: () => undefined, drain: drain(false), exit: (code) => { exits.push(code); } });
    expect(drained).not.toHaveBeenCalled();
    drained.mockRejectedValue(new Error('the slices could not be read'));
    await stopBackend({ stopping: () => undefined, drain: drain(true), exit: (code) => { exits.push(code); } });
    expect(exits).toEqual([0, 1]);
  });
});
