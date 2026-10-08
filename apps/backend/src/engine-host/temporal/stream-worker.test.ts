import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTurnLogBus, notifyTurnLog, TURN_LOG_CHANNEL, userRoom } from './stream-worker.js';
import type { EngineEvent } from '@koala/agent-engine';
import type { TurnLogEntry } from '../../lib/turn-log.js';

const at = '2026-10-05T00:00:00.000Z';

const rooms = () => {
  const sent: { room: string; channel: string; payload: unknown }[] = [];
  return { sent, io: { to: (room: string) => ({ emit: (channel: string, payload: unknown) => { sent.push({ room, channel, payload }); } }) } };
};

afterEach(() => { vi.useRealTimers(); });

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
