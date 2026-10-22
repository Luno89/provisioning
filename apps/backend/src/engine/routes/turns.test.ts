import { describe, it, expect, afterAll } from 'vitest';
import { turnsRouter } from './turns.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';

const at = '2026-10-05T00:00:00.000Z';
const before = '2026-10-02T00:00:00.000Z';
const harness: Harness = await mountRouter({
  prefix: '/api/turns',
  router: (db) => {
    void Promise.all([
      db.engine.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 1, at, events: [{ type: 'run.started', runId: 'r1', at, agentId: 'koala', loopId: 'interactive-chat' } as never] }),
      db.engine.appendTurnLog({ turnId: 'r-old', ownerId: TEST_USER.id, seq: 1, at: '2026-10-03T00:00:00.000Z', events: [] }),
      db.engine.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 2, at, events: [] }),
      db.engine.appendTurnLog({ turnId: 'r2', ownerId: 'someone-else', seq: 1, at, events: [] }),
      db.engine.appendTurnLog({ turnId: 'grove', ownerId: TEST_USER.id, seq: 1, at: before, events: [
        { type: 'run.started', runId: 'grove', at, agentId: 'grove-runner', loopId: 'grove-run' },
        { type: 'run.started', runId: 'leaf-1', at, agentId: 'grove-leaf', loopId: 'grove-leaf', parentRunId: 'grove' },
      ] as never }),
      db.engine.appendTurnLog({ turnId: 'grove', ownerId: TEST_USER.id, seq: 2, at: before, events: [{ type: 'run.started', runId: 'leaf-2', at, agentId: 'grove-leaf', loopId: 'grove-leaf', parentRunId: 'grove' }] as never }),
      db.engine.appendTurnLog({ turnId: 'grove', ownerId: TEST_USER.id, seq: 3, at: before, events: [
        { type: 'run.started', runId: 'leaf-1-exec', at, agentId: 'executor', loopId: 'do-one-task', parentRunId: 'leaf-1' },
        { type: 'thinking', runId: 'leaf-2', at, nodeId: 'turn.call', delta: 'not this story' },
        { type: 'thinking', runId: 'leaf-1-exec', at, nodeId: 'turn.call', delta: 'this story' },
      ] as never }),
      db.engine.appendTurnLog({ turnId: 'grove', ownerId: TEST_USER.id, seq: 4, at: before, events: [{ type: 'content', runId: 'grove', at, nodeId: 'n', delta: 'the tree' }] as never }),
    ]);
    return turnsRouter({ log: { read: (ownerId, turnId, after) => db.engine.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.engine.recentTurns(ownerId, since, limit) }, now: () => new Date('2026-10-05T12:00:00.000Z') });
  },
});

afterAll(async () => { await harness.close(); });

const read = async (path: string) => {
  const res = await fetch(harness.url(`/api/turns/${path}`));
  return { status: res.status, body: await res.json() as { entries?: { seq: number; ownerId?: string }[]; error?: string } };
};

describe('listing recent turns', () => {
  it('lists the person\'s own turns from the last day, newest first, with the agent each ran', async () => {
    const res = await fetch(harness.url('/api/turns'));
    expect(await res.json()).toEqual({ turns: [{ turnId: 'r1', at, agentId: 'koala' }] });
  });
});

describe('reading a turn\'s log', () => {
  it('gives the person\'s own turn from after a position, without the owner on it', async () => {
    expect((await read('r1')).body.entries!.map((entry) => entry.seq)).toEqual([1, 2]);
    const after = (await read('r1?after=1')).body.entries!;
    expect(after.map((entry) => entry.seq)).toEqual([2]);
    expect(after[0]).not.toHaveProperty('ownerId');
  });

  it('gives nothing of someone else\'s turn, and refuses a position that is not one', async () => {
    expect((await read('r2')).body.entries).toEqual([]);
    expect((await read('r1?after=-1')).status).toBe(400);
    expect((await read('r1?after=x')).status).toBe(400);
  });
});

describe('reading only one run and the runs it started', () => {
  it('leaves out every other run, and says how far the log it read goes so a follower does not wait for the rest', async () => {
    const res = await fetch(harness.url('/api/turns/grove?after=0&under=leaf-1'));
    const body = await res.json() as { entries: { seq: number; events: { runId: string; delta?: string }[] }[]; through: number };

    expect(body.through).toBe(4);
    expect(body.entries.map((entry) => [entry.seq, entry.events.map((event) => event.runId)])).toEqual([[1, ['leaf-1']], [3, ['leaf-1-exec', 'leaf-1-exec']]]);
    expect(body.entries[1]!.events[1]!.delta).toBe('this story');
  });
});
