import { describe, it, expect, afterAll } from 'vitest';
import { turnsRouter } from './turns.js';
import { mountRouter, TEST_USER, type Harness } from './test-harness.js';

const at = '2026-10-05T00:00:00.000Z';
const harness: Harness = await mountRouter({
  prefix: '/api/turns',
  router: (db) => {
    void Promise.all([
      db.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 1, at, events: [] }),
      db.appendTurnLog({ turnId: 'r1', ownerId: TEST_USER.id, seq: 2, at, events: [] }),
      db.appendTurnLog({ turnId: 'r2', ownerId: 'someone-else', seq: 1, at, events: [] }),
    ]);
    return turnsRouter({ log: { read: (ownerId, turnId, after) => db.getTurnLog(ownerId, turnId, after) } });
  },
});

afterAll(async () => { await harness.close(); });

const read = async (path: string) => {
  const res = await fetch(harness.url(`/api/turns/${path}`));
  return { status: res.status, body: await res.json() as { entries?: { seq: number; ownerId?: string }[]; error?: string } };
};

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
