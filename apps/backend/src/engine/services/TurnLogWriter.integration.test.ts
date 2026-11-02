import { beforeEach, describe, expect, it } from 'vitest';
import type { EngineEvent } from '@koala/agent-engine';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { TurnLogEntry } from '../lib/turn-log.js';
import { TurnLogWriter } from './TurnLogWriter.js';

const at = '2026-10-05T00:00:00.000Z';
const ev = (event: Record<string, unknown>): EngineEvent => ({ runId: 't1', at, ownerId: 'u1', turnId: 't1', ...event }) as unknown as EngineEvent;
const fresh = await emptiedEachTime();

let db: MongoDB;
let heard: TurnLogEntry[];
let failNext: number;

const store = () => ({
  appendTurnLog: async (entry: TurnLogEntry) => {
    if (failNext > 0) { failNext -= 1; throw new Error('mongo is away'); }
    await db.engine.appendTurnLog(entry);
  },
  lastTurnLogSeq: (turnId: string) => db.engine.lastTurnLogSeq(turnId),
});

const writer = () => new TurnLogWriter({ store: store(), notify: (entry) => { heard.push(entry); }, flushMs: 20, now: () => new Date(at) });
const stored = (turnId: string) => db.engine.getTurnLog('u1', turnId, 0);
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

beforeEach(async () => {
  db = await fresh();
  heard = [];
  failNext = 0;
});

describe('writing a turn\'s log to the database', () => {
  it('gathers a moment of events into one numbered entry, joining text, and tells the browser only after it is stored', async () => {
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'Hel' }));
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'lo' }));
    expect(await stored('t1')).toEqual([]);

    await settle(80);
    w.accept(ev({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'research', args: '{}' }));
    w.accept(ev({ type: 'run.started', runId: 't1-research-1', agentId: 'research', loopId: 'research', parentRunId: 't1', parentCallId: 'c1' }));
    await w.drain();

    const entries = await stored('t1');
    expect(entries.map((entry) => [entry.seq, entry.events.map((event) => event.type)])).toEqual([[1, ['content']], [2, ['tool.called', 'run.started']]]);
    expect((entries[0]!.events[0] as { delta: string }).delta).toBe('Hello');
    expect(entries[0]).toMatchObject({ turnId: 't1', ownerId: 'u1', at });
    expect(entries[0]!.events[0]).not.toHaveProperty('ownerId');
    expect(heard).toEqual(entries);
  });

  it('writes at once when the turn ends, and carries on numbering from what the database already holds after a restart', async () => {
    await writer().drain();
    const before = writer();
    before.accept(ev({ type: 'content', nodeId: 'turn', delta: 'first' }));
    await before.drain();
    const restarted = writer();
    restarted.accept(ev({ type: 'content', nodeId: 'turn', delta: 'done' }));
    restarted.accept(ev({ type: 'run.finished', outcome: 'ok' }));
    await restarted.drain();

    expect((await stored('t1')).map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('keeps a turn\'s events through a failed write and writes them, in order, under the next number, telling the browser nothing until then', async () => {
    failNext = 1;
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'a' }));
    await settle(60);
    expect(heard).toEqual([]);
    expect(await stored('t1')).toEqual([]);

    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'b' }));
    await w.drain();

    const entries = await stored('t1');
    expect(entries.map((entry) => [entry.seq, (entry.events[0] as { delta: string }).delta])).toEqual([[1, 'ab']]);
    expect(heard).toEqual(entries);
  });

  it('ignores an event that names no turn or no owner', async () => {
    const w = writer();
    w.accept({ type: 'content', runId: 't1', at, nodeId: 'turn', delta: 'x', ownerId: 'u1' } as EngineEvent);
    w.accept({ type: 'content', runId: 't1', at, nodeId: 'turn', delta: 'x', turnId: 't1' } as EngineEvent);
    await w.drain();

    expect(await stored('t1')).toEqual([]);
    expect(heard).toEqual([]);
  });

  it('keeps each turn\'s numbers separate', async () => {
    const w = writer();
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'one' }));
    w.accept(ev({ type: 'content', nodeId: 'turn', delta: 'two', runId: 't2', turnId: 't2' }));
    await w.drain();

    expect(heard.map((entry) => [entry.turnId, entry.seq]).sort()).toEqual([['t1', 1], ['t2', 1]]);
    expect((await stored('t2')).map((entry) => entry.seq)).toEqual([1]);
  });
});
