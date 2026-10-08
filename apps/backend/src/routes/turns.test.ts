import { describe, it, expect, afterAll } from 'vitest';
import { turnsRouter } from './turns.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

const at = '2026-10-05T00:00:00.000Z';
const harness: Harness = await mountRouter({
  prefix: '/api/turns',
  router: (db) => {
    void Promise.all([
      db.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 1, at, events: [{ type: 'run.started', runId: 'r1', at, agentId: 'koala', loopId: 'interactive-chat' } as never] }),
      db.appendTurnLog({ turnId: 'r-old', ownerId: TEST_USER.id, seq: 1, at: '2026-10-03T00:00:00.000Z', events: [] }),
      db.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 2, at, events: [] }),
      db.appendTurnLog({ turnId: 'r2', ownerId: 'someone-else', seq: 1, at, events: [] }),
    ]);
    return turnsRouter({ log: { read: (ownerId, turnId, after) => db.getTurnLog(ownerId, turnId, after), recent: (ownerId, since, limit) => db.recentTurns(ownerId, since, limit) }, now: () => new Date('2026-10-05T12:00:00.000Z') });
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
