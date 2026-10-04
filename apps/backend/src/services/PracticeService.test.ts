import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { PracticeService } from './PracticeService.js';

let db: MemoryDB;
const practices = () => new PracticeService({ store: db, now: () => 'now' });
const practice = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'p1', ownerId: 'u1', category: 'practice', agent: 'koala', status: 'trial', title: 'Check before answering', text: 'Call list_infrastructure first.', createdAt: 'then', updatedAt: 'then', ...over,
});

beforeEach(async () => {
  db = new MemoryDB();
  await db.saveMemory(practice({}));
  await db.saveMemory(practice({ id: 'fact', category: 'environment_facts', status: 'active' }));
  await db.saveMemory(practice({ id: 'theirs', ownerId: 'someone-else' }));
});

describe('practices', () => {
  it('are only the person\'s own practices, and trials are the ones not yet checked', async () => {
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['p1']);
    expect((await practices().trials('u1')).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('settle once: live or held, with the trial they went through', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now', runId: 'r1', regressions: ['x'] }, false);
    expect((await practices().list('u1'))[0]).toMatchObject({ status: 'pending_review', trial: { runId: 'r1', regressions: ['x'] } });
    await practices().settle('u1', 'p1', { checkedAt: 'later' }, true);
    expect((await practices().list('u1'))[0]!.status).toBe('pending_review');
  });

  it('can be made live by the person, and retired', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now', regressions: ['x'] }, false);
    expect(await practices().makeLive('u1', 'p1')).toMatchObject({ status: 'active' });
    expect(await practices().makeLive('u1', 'p1')).toBeUndefined();
    expect(await practices().retire('u1', 'p1')).toBe(true);
    expect(await practices().list('u1')).toEqual([]);
  });
});
