import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../platform/lib/db-interface.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { practiceMemory as practice, toolNoteMemory as note } from '../testing/memories.js';
import { practiceBehaviour } from '../testing/practice-behaviour.js';
import { PracticeService } from './PracticeService.js';

let db: Database;
let unindexed: string[][];
let indexed: string[][];
let indexRefuses: Error | undefined;
const indexing = {
  unindex: async (_ownerId: string, ids: string[]) => { if (indexRefuses) throw indexRefuses; unindexed.push(ids); },
  index: async (items: MemoryItem[]) => { indexed.push(items.map((item) => item.id)); },
};
const practices = () => new PracticeService({ store: db.memory, indexing, now: () => 'now' });
const notes = () => new PracticeService({ store: db.memory, indexing, category: 'tool_note', now: () => 'now' });

practiceBehaviour(async () => ({ store: memoryDatabase().memory, indexing }));

beforeEach(async () => {
  db = memoryDatabase();
  unindexed = [];
  indexed = [];
  indexRefuses = undefined;
  await db.memory.saveMemory(practice({}));
  await db.memory.saveMemory(practice({ id: 'theirs', ownerId: 'someone-else' }));
  await db.memory.saveMemory(note({ server: 'playwright', tool: 'browser_click' }));
  await db.memory.saveMemory(note({ id: 'n2', server: 'playwright', status: 'active' }));
});

describe('practices, held to the index', () => {
  it('are listed newest first, and not once retired', async () => {
    await db.memory.saveMemory(practice({ id: 'newer', updatedAt: 'zzz' }));
    await db.memory.saveMemory(practice({ id: 'retired', updatedAt: 'zzzz', invalidAt: 'then' }));
    expect((await practices().list('u1')).map((entry) => entry.id)).toEqual(['newer', 'p1']);
  });

  it('settle nothing that is not on trial or not the person\'s', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now' }, true);
    expect((await practices().list('u1'))[0]).toMatchObject({ status: 'active', updatedAt: 'now' });
    await practices().settle('u1', 'theirs', { checkedAt: 'now' }, true);
    expect((await db.memory.getMemories('someone-else'))[0]).toMatchObject({ status: 'trial', updatedAt: 'then' });
    await practices().settle('u1', 'nothing', { checkedAt: 'now' }, true);
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

  it('are indexed as they go live from being held, so recall finds them for their agent at once', async () => {
    await practices().settle('u1', 'p1', { checkedAt: 'now', regressions: ['x'] }, false);
    expect(indexed).toEqual([]);
    await practices().makeLive('u1', 'p1');
    expect(indexed).toEqual([['p1']]);
  });

  it('are stamped with the clock when none is given', async () => {
    await new PracticeService({ store: db.memory, indexing }).retire('u1', 'p1');
    const [retired] = (await db.memory.getMemories('u1')).filter((entry) => entry.id === 'p1');
    expect(Date.parse(retired!.invalidAt!)).not.toBeNaN();
  });
});

describe('tool notes, held to the index', () => {
  it('keep their place in the index when their server is renamed, and leave it with the server', async () => {
    await notes().renameServer('u1', 'playwright', 'browser');
    expect([unindexed, indexed]).toEqual([[], []]);
    await notes().forgetServer('u1', 'browser');
    expect(unindexed.flat().sort()).toEqual(['n1', 'n2']);
  });

  it('leave other servers\' notes alone when one is renamed or forgotten', async () => {
    expect(await notes().renameServer('u1', 'elsewhere', 'browser')).toBe(0);
    expect(await notes().forgetServer('u1', 'elsewhere')).toBe(0);
    expect((await notes().list('u1')).map((entry) => entry.id).sort()).toEqual(['n1', 'n2']);
  });
});
