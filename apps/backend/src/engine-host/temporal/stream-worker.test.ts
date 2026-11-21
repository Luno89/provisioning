import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTurnLogBus, notifyProjectDeletion, notifyTurnLog, streamWorkerRun, TURN_LOG_CHANNEL, userRoom } from './stream-worker.js';
import { PROJECT_DELETION } from '../../projects/index.js';
import type { EngineEvent } from '@koala/agent-engine';
import type { TurnLogEntry } from '../../engine/lib/turn-log.js';

const at = '2026-10-05T00:00:00.000Z';

const rooms = () => {
  const sent: { room: string; channel: string; payload: unknown }[] = [];
  return { sent, io: { to: (room: string) => ({ emit: (channel: string, payload: unknown) => { sent.push({ room, channel, payload }); } }) } };
};

afterEach(() => { vi.useRealTimers(); });

describe('telling browsers where a project\'s deletion stands', () => {
  it('sends it to its owner\'s browsers only', () => {
    const { io, sent } = rooms();
    const event = { projectId: 'p1', progress: { seq: 1, phase: 'deleting' as const, work: [], parts: {} } };
    notifyProjectDeletion(io)('u1', event);
    expect(sent).toEqual([{ room: userRoom('u1'), channel: PROJECT_DELETION, payload: event }]);
  });
});

describe('telling browsers about a turn', () => {
  it('sends a written entry to its owner\'s browsers only, without the owner on it', () => {
    const { io, sent } = rooms();
    notifyTurnLog(io)({ turnId: 't1', ownerId: 'u1', seq: 3, events: [], at });

    expect(sent).toEqual([{ room: userRoom('u1'), channel: TURN_LOG_CHANNEL, payload: { turnId: 't1', seq: 3, events: [], at } }]);
  });

  it('keeps going when a socket throws', () => {
    const io = { to: () => ({ emit: () => { throw new Error('socket went away'); } }) };
    expect(() => notifyTurnLog(io)({ turnId: 't1', ownerId: 'u1', seq: 1, events: [], at })).not.toThrow();
  });

  it('writes every event to its turn\'s log before any browser hears of it, and nothing goes out raw', async () => {
    vi.useFakeTimers();
    const { io, sent } = rooms();
    const written: TurnLogEntry[] = [];
    const bus = createTurnLogBus({ io, turnLogs: { appendTurnLog: async (entry) => { written.push(entry); }, lastTurnLogSeq: async () => 0 } });

    bus.emit({ type: 'content', runId: 't1', at, nodeId: 'turn', delta: 'hi', ownerId: 'u1', turnId: 't1' } as unknown as EngineEvent);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);

    expect(written).toHaveLength(1);
    expect(sent.map(({ channel }) => channel)).toEqual([TURN_LOG_CHANNEL]);
  });
});

const fakeWorker = () => {
  let state: 'INITIALIZED' | 'RUNNING' | 'DRAINING' | 'STOPPED' = 'INITIALIZED';
  let ended: () => void = () => undefined;
  const calls: string[] = [];
  return {
    calls,
    worker: {
      getState: () => state,
      run: () => { state = 'RUNNING'; calls.push('run'); return new Promise<void>((done) => { ended = () => { state = 'STOPPED'; done(); }; }); },
      shutdown: () => { if (state !== 'RUNNING') throw new Error(`Not running. Current state: ${state}`); state = 'DRAINING'; calls.push('shutdown'); },
    },
    finish: () => { ended(); },
  };
};

describe('the stream worker stopping with the backend', () => {
  it('stops taking work at once and is stopped only once the work it holds has finished', async () => {
    const { worker, calls, finish } = fakeWorker();
    const run = streamWorkerRun(() => undefined);
    run.started(worker);
    let stopped = false;
    const stopping = run.stop().then(() => { stopped = true; });
    expect(calls).toEqual(['run', 'shutdown']);
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('never lets a worker that connects after the backend began stopping take work', async () => {
    const { worker, calls, finish } = fakeWorker();
    const run = streamWorkerRun(() => undefined);
    await run.stop();
    expect(run.stopping()).toBe(true);
    run.started(worker);
    expect(calls).toEqual(['run', 'shutdown']);
    finish();
  });

  it('says why when the worker ends in a failure while it stops', async () => {
    const said: string[] = [];
    const run = streamWorkerRun((line) => { said.push(line); });
    run.started({ getState: () => 'RUNNING', run: () => Promise.reject(new Error('the connection to Temporal broke')), shutdown: () => undefined });
    await run.stop();
    expect(said).toEqual(['[engine] stream worker stopped: the connection to Temporal broke']);
  });
});
