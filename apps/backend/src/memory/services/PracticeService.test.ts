import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { PracticeService } from './PracticeService.js';

let db: Database;
let unindexed: string[][];
let indexRefuses: Error | undefined;
const unindex = async (_ownerId: string, ids: string[]) => { if (indexRefuses) throw indexRefuses; unindexed.push(ids); };
const practices = () => new PracticeService({ store: db.memory, unindex, now: () => 'now' });
const practice = (over: Partial<MemoryItem>): MemoryItem => ({
  id: 'p1', ownerId: 'u1', category: 'practice', agent: 'koala', status: 'trial', title: 'Check before answering', text: 'Call list_infrastructure first.', createdAt: 'then', updatedAt: 'then', ...over,
});

beforeEach(async () => {
  db = memoryDatabase();
  unindexed = [];
  indexRefuses = undefined;
  await db.memory.saveMemory(practice({}));
  await db.memory.saveMemory(practice({ id: 'fact', category: 'environment_facts', status: 'active' }));
  await db.memory.saveMemory(practice({ id: 'theirs', ownerId: 'someone-else' }));
});

describe('practices', () => {
  it('are only the person\'s own practices, and trials are the ones not yet checked', async () => {
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['p1']);
    expect((await practices().trials('u1')).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('are listed newest first, and not once retired', async () => {
    await db.memory.saveMemory(practice({ id: 'newer', updatedAt: 'zzz' }));
    await db.memory.saveMemory(practice({ id: 'retired', updatedAt: 'zzzz', invalidAt: 'then' }));
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['newer', 'p1']);
  });

  it('settle once: live or held, with the trial they went through', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now', runId: 'r1', regressions: ['x'] }, false);
    expect((await practices().list('u1'))[0]).toMatchObject({ status: 'pending_review', trial: { runId: 'r1', regressions: ['x'] } });
    await practices().settle('u1', 'p1', { checkedAt: 'later' }, true);
    expect((await practices().list('u1'))[0]!.status).toBe('pending_review');
  });

  it('settle nothing that is not on trial or not the person\'s', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now' }, true);
    expect((await practices().list('u1'))[0]).toMatchObject({ status: 'active', updatedAt: 'now' });
    await practices().settle('u1', 'theirs', { checkedAt: 'now' }, true);
    expect((await db.memory.getMemories('someone-else'))[0]).toMatchObject({ status: 'trial', updatedAt: 'then' });
    await practices().settle('u1', 'nothing', { checkedAt: 'now' }, true);
  });

  it('can be made live by the person, and retired', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now', regressions: ['x'] }, false);
    expect(await practices().makeLive('u1', 'p1')).toMatchObject({ status: 'active' });
    expect(await practices().makeLive('u1', 'p1')).toBeUndefined();
    expect(await practices().retire('u1', 'p1')).toBe(true);
    expect(await practices().list('u1')).toEqual([]);
  });

  it('are taken out of the index before they are retired', async () => {
    await practices().retire('u1', 'p1');
    expect(unindexed).toEqual([['p1']]);
  });

  it('stay as they are when the index will not let go, saying why', async () => {
    indexRefuses = new Error('Quickwit refused: HTTP 500 split store unavailable');
    await expect(practices().retire('u1', 'p1')).rejects.toThrow('Quickwit refused: HTTP 500 split store unavailable');
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['p1']);
  });

  it('cannot be made live or retired by someone else, or when there is no such practice', async () => {
    expect(await practices().makeLive('u1', 'theirs')).toBeUndefined();
    expect(await practices().retire('u1', 'theirs')).toBe(false);
    expect(await practices().retire('u1', 'nothing')).toBe(false);
    expect((await db.memory.getMemories('someone-else'))[0]!.invalidAt).toBeUndefined();
  });

  it('are stamped with the clock when none is given', async () => {
    const service = new PracticeService({ store: db.memory, unindex });
    await service.retire('u1', 'p1');
    const [retired] = (await db.memory.getMemories('u1')).filter((entry) => entry.id === 'p1');
    expect(Date.parse(retired!.invalidAt!)).not.toBeNaN();
  });
});

describe('tool notes', () => {
  const notes = () => new PracticeService({ store: db.memory, unindex, category: 'tool_note', now: () => 'now' });
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
    expect(unindexed.flat().sort()).toEqual(['n1', 'n2']);
  });

  it('leave other servers\' notes alone when one is renamed or forgotten', async () => {
    expect(await notes().renameServer('u1', 'elsewhere', 'browser')).toBe(0);
    expect(await notes().forgetServer('u1', 'elsewhere')).toBe(0);
    expect((await notes().list('u1')).map((entry) => entry.id).sort()).toEqual(['n1', 'n2', 'n3']);
  });
});
