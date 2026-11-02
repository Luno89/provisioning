import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { TurnLogEntry } from '../lib/turn-log.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { RECENT_TURNS_HOURS, RECENT_TURNS_SHOWN, turnsRouter } from './turns.js';

type Log = Parameters<typeof turnsRouter>[0]['log'];

const at = '2026-10-05T00:00:00.000Z';
const entry = (seq: number, events: unknown[] = [], turnId = 'grove'): TurnLogEntry => ({ turnId, ownerId: TEST_USER.id, seq, at, events: events as never });
const started = (runId: string, parentRunId?: string) => ({ type: 'run.started', runId, at, agentId: 'a', loopId: 'l', ...(parentRunId ? { parentRunId } : {}) });

let log: ReturnType<typeof mock<Log>>;
let app: InProcessRoutes;

beforeEach(async () => {
  log = mock<Log>();
  app = await routesInProcess({ prefix: '/api/turns', router: () => turnsRouter({ log, now: () => new Date('2026-10-05T12:00:00.000Z') }) });
});

describe('listing recent turns', () => {
  it('asks for the person\'s turns of the last day, a bounded number, and names the agent each ran', async () => {
    log.recent.mockResolvedValue([
      { turnId: 'r1', ownerId: TEST_USER.id, seq: 1, at, events: [started('r1') as never] },
      { turnId: 'r2', ownerId: TEST_USER.id, seq: 1, at, events: [] },
      { turnId: 'r3', ownerId: TEST_USER.id, seq: 1, at, events: [started('other') as never] },
    ]);

    expect(await app.get('/api/turns')).toMatchObject({ status: 200, data: { turns: [{ turnId: 'r1', at, agentId: 'a' }, { turnId: 'r2', at }, { turnId: 'r3', at }] } });
    expect(log.recent).toHaveBeenCalledWith(TEST_USER.id, new Date(new Date('2026-10-05T12:00:00.000Z').getTime() - RECENT_TURNS_HOURS * 3_600_000).toISOString(), RECENT_TURNS_SHOWN);
  });

  it('leaves the agent off a turn that began no run of its own', async () => {
    log.recent.mockResolvedValue([{ turnId: 'r2', ownerId: TEST_USER.id, seq: 1, at, events: [] }]);
    expect((await app.get<{ turns: object[] }>('/api/turns')).data.turns[0]).toEqual({ turnId: 'r2', at });
  });

  it('takes the time from the clock when none is given', async () => {
    const plain = await routesInProcess({ prefix: '/api/turns', router: () => turnsRouter({ log }) });
    log.recent.mockResolvedValue([]);
    expect(await plain.get('/api/turns')).toMatchObject({ status: 200, data: { turns: [] } });
  });
});

describe('reading a turn\'s log', () => {
  it('gives the person\'s turn from after a position, without the owner on it', async () => {
    log.read.calledWith(TEST_USER.id, 'r1', 1).mockResolvedValue([entry(2, [], 'r1')]);
    const read = await app.get<{ entries: { seq: number }[] }>('/api/turns/r1?after=1');
    expect(read.data.entries.map((one) => one.seq)).toEqual([2]);
    expect(read.data.entries[0]).not.toHaveProperty('ownerId');
  });

  it('reads from the start when no position is given', async () => {
    log.read.mockResolvedValue([]);
    await app.get('/api/turns/r1');
    expect(log.read).toHaveBeenCalledWith(TEST_USER.id, 'r1', 0);
  });

  it('refuses a position that is not a whole number of 0 or more, before the log is read', async () => {
    expect((await app.get('/api/turns/r1?after=-1')).status).toBe(400);
    expect((await app.get('/api/turns/r1?after=x')).status).toBe(400);
    expect((await app.get('/api/turns/r1?after=1.5')).status).toBe(400);
    expect(log.read).not.toHaveBeenCalled();
  });

  it('gives only one run and the runs it started, and says how far the log it read goes', async () => {
    log.read.mockResolvedValue([
      entry(1, [started('leaf-1', 'grove'), started('leaf-2', 'grove')]),
      entry(3, [started('leaf-1-exec', 'leaf-1'), { type: 'thinking', runId: 'leaf-2', at, nodeId: 'n', delta: 'not this story' }, { type: 'thinking', runId: 'leaf-1-exec', at, nodeId: 'n', delta: 'this story' }]),
      entry(4, [{ type: 'content', runId: 'grove', at, nodeId: 'n', delta: 'the tree' }]),
    ]);
    const read = await app.get<{ entries: { seq: number; events: { runId: string; delta?: string }[] }[]; through: number }>('/api/turns/grove?under=leaf-1');
    expect(read.data.through).toBe(4);
    expect(read.data.entries.map((one) => [one.seq, one.events.map((event) => event.runId)])).toEqual([[1, ['leaf-1']], [3, ['leaf-1-exec', 'leaf-1-exec']]]);
  });

  it('ignores an empty run to follow', async () => {
    log.read.mockResolvedValue([entry(1)]);
    expect((await app.get('/api/turns/grove?under=%20')).data).toMatchObject({ entries: [{ seq: 1 }] });
  });
});
