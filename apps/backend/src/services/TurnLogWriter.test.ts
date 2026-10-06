import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EngineEvent } from '@koala/agent-engine';
import { TurnLogWriter } from './TurnLogWriter.js';
import type { TurnLogEntry } from '../lib/turn-log.js';

const at = '2026-10-05T00:00:00.000Z';
const ev = (event: Record<string, unknown>): EngineEvent => ({ runId: 't1', at, ownerId: 'u1', turnId: 't1', ...event }) as unknown as EngineEvent;

let written: TurnLogEntry[];
let heard: TurnLogEntry[];
let failNext: number;
let startingAt: number;

const store = {
  appendTurnLog: async (entry: TurnLogEntry) => {
    if (failNext > 0) { failNext -= 1; throw new Error('mongo is away'); }
    written.push(entry);
  },
  lastTurnLogSeq: async () => startingAt,
};

const writer = () => new TurnLogWriter({ store, notify: (entry) => { heard.push(entry); }, flushMs: 100, now: () => new Date(at) });

beforeEach(() => {
  vi.useFakeTimers();
  written = [];
  heard = [];
  failNext = 0;
  startingAt = 0;
});

afterEach(() => { vi.useRealTimers(); });

describe('writing a turn\'s log', () => {
  it('gathers a moment of events into one numbered entry, joining text, and tells the browser only after it is written', async () => {
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'Hel' }));
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'lo' }));
    expect(written).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    w.accept(ev({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'research', args: '{}' }));
    w.accept(ev({ type: 'run.started', runId: 't1-research-1', agentId: 'research', loopId: 'research', parentRunId: 't1', parentCallId: 'c1' }));
    await vi.advanceTimersByTimeAsync(100);

    expect(written.map((entry) => [entry.seq, entry.events.map((event) => event.type)])).toEqual([[1, ['content']], [2, ['tool.called', 'run.started']]]);
    expect((written[0]!.events[0] as { delta: string }).delta).toBe('Hello');
    expect(written[0]).toMatchObject({ turnId: 't1', ownerId: 'u1', at });
    expect(written[0]!.events[0]).not.toHaveProperty('ownerId');
    expect(heard).toEqual(written);
  });

  it('writes at once when the turn ends, and carries on numbering from what the log already holds after a restart', async () => {
    startingAt = 7;
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'done' }));
    w.accept(ev({ type: 'run.finished', outcome: 'ok' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(written.map((entry) => entry.seq)).toEqual([8]);
  });

  it('keeps a turn\'s events through a failed write and writes them, in order, under the next number, telling the browser nothing until then', async () => {
    failNext = 1;
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'a' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(heard).toEqual([]);

    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'b' }));
    await vi.advanceTimersByTimeAsync(400);

    expect(written.map((entry) => [entry.seq, (entry.events[0] as { delta: string }).delta])).toEqual([[1, 'ab']]);
    expect(heard).toEqual(written);
  });

  it('ignores an event that names no turn or no owner', async () => {
    const w = writer();
    w.accept({ type: 'content', runId: 't1', at, nodeId: 'turn', delta: 'x', ownerId: 'u1' } as EngineEvent);
    w.accept({ type: 'content', runId: 't1', at, nodeId: 'turn', delta: 'x', turnId: 't1' } as EngineEvent);
    await w.drain();

    expect(written).toEqual([]);
  });

  it('keeps each turn\'s numbers separate', async () => {
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'one' }));
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'two', runId: 't2', turnId: 't2' }));
    await w.drain();

    expect(written.map((entry) => [entry.turnId, entry.seq])).toEqual([['t1', 1], ['t2', 1]]);
  });
});
