import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server } from 'node:http';
import { drainThenStop } from '../services/drain.js';
import { stopBackend } from './shutdown.js';

vi.mock('../services/drain.js', () => ({ drainThenStop: vi.fn() }));

const drained = vi.mocked(drainThenStop);
const place = { ip: '10.42.0.9', namespace: 'nowrinkles' };
const drain = (inPod: boolean) => ({ place: inPod ? place : undefined, server: mock<Server>(), log: () => undefined });
const sockets = { stopTaking: () => undefined };
const streams = { stop: async () => undefined };

beforeEach(() => { drained.mockReset(); });

describe('the backend stopping cleanly', () => {
  it('stops what it runs, sends every browser connection and every stream task to the backend that stays before it drains in a pod, then exits once its stream work has finished', async () => {
    const order: string[] = [];
    let finishStreams: () => void = () => undefined;
    drained.mockImplementation(async () => { order.push('drain'); finishStreams(); });
    await stopBackend({
      stopping: () => { order.push('stop'); },
      sockets: { stopTaking: () => { order.push('stop taking sockets'); } },
      streams: { stop: () => { order.push('stop taking stream tasks'); return new Promise<void>((done) => { finishStreams = () => { order.push('stream work finished'); done(); }; }); } },
      drain: drain(true),
      exit: (code) => { order.push(`exit ${code}`); },
    });
    expect(order).toEqual(['stop', 'stop taking sockets', 'stop taking stream tasks', 'drain', 'stream work finished', 'exit 0']);
  });

  it('outside a pod waits for the stream work it holds before it exits', async () => {
    const order: string[] = [];
    let finishStreams: () => void = () => undefined;
    const stopped = stopBackend({
      stopping: () => undefined,
      sockets,
      streams: { stop: () => new Promise<void>((done) => { finishStreams = done; }) },
      drain: drain(false),
      exit: (code) => { order.push(`exit ${code}`); },
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    finishStreams();
    await stopped;
    expect(order).toEqual(['exit 0']);
  });

  it('drains nothing outside a pod but still sends its browser connections away, and exits with how the drain went', async () => {
    const exits: number[] = [];
    const outside = { stopTaking: vi.fn() };
    await stopBackend({ stopping: () => undefined, sockets: outside, streams, drain: drain(false), exit: (code) => { exits.push(code); } });
    expect(drained).not.toHaveBeenCalled();
    expect(outside.stopTaking).toHaveBeenCalledTimes(1);
    drained.mockRejectedValue(new Error('the slices could not be read'));
    await stopBackend({ stopping: () => undefined, sockets, streams, drain: drain(true), exit: (code) => { exits.push(code); } });
    expect(exits).toEqual([0, 1]);
  });
});
