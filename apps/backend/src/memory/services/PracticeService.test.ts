import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { PracticeService } from './PracticeService.js';

let db: MongoDB;
const practices = () => new PracticeService({ store: db.memory, now: () => 'now' });
const practice = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'p1', ownerId: 'u1', category: 'practice', agent: 'koala', status: 'trial', title: 'Check before answering', text: 'Call list_infrastructure first.', createdAt: 'then', updatedAt: 'then', ...over,
});

beforeEach(async () => {
  db = await testDatabase();
  await db.memory.saveMemory(practice({}));
  await db.memory.saveMemory(practice({ id: 'fact', category: 'environment_facts', status: 'active' }));
  await db.memory.saveMemory(practice({ id: 'theirs', ownerId: 'someone-else' }));
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

describe('tool notes', () => {
  const notes = () => new PracticeService({ store: db.memory, category: 'tool_note', now: () => 'now' });
  const note = (over: Partial<MemoryItem>): MemoryItem => ({ id: 'n1', ownerId: 'u1', category: 'tool_note', status: 'trial', title: 'Note', text: 'A note.', createdAt: 'then', updatedAt: 'then', ...over });

  beforeEach(async () => {
    await db.memory.saveMemory(note({ server: 'playwright', tool: 'browser_click' }));
    await db.memory.saveMemory(note({ id: 'n2', server: 'playwright', status: 'active' }));
    await db.memory.saveMemory(note({ id: 'n3', tool: 'start_task' }));
  });

  it('are kept apart from practices, and go through the same trial', async () => {
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['p1']);
    expect((await notes().trials('u1')).map((entry) => entry.id).sort()).toEqual(['n1', 'n3']);
    await notes().settle('u1', 'n1', { checkedAt: 'now', runId: 'r1', regressions: [], better: ['claims'] }, true);
    expect((await notes().list('u1')).find((entry) => entry.id === 'n1')).toMatchObject({ status: 'active', trial: { better: ['claims'] } });
  });

  it('follow their server when it is renamed, and are retired with it', async () => {
    expect(await notes().renameServer('u1', 'playwright', 'browser')).toBe(2);
    expect((await notes().list('u1')).filter((entry) => entry.server === 'browser').map((entry) => entry.id).sort()).toEqual(['n1', 'n2']);
    expect(await notes().forgetServer('u1', 'browser')).toBe(2);
    expect((await notes().list('u1')).map((entry) => entry.id)).toEqual(['n3']);
  });
});
