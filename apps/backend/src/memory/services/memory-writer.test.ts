import { describe, it, expect, beforeEach } from 'vitest';
import { dnsMemory } from '../testing/memories.js';
import { DependencyDownError } from '../../platform/index.js';
import type { MemoryItem } from '../lib/memory-store.js';
import { createMemoryWriter, indexOnRecovery, indexPendingMemories } from './memory-writer.js';

let bank: Map<string, MemoryItem>;
let indexed: string[][];
let unindexed: string[];
let indexFails: Error | undefined;

const store = {
  list: async (ownerId?: string) => [...bank.values()].filter((item) => !ownerId || item.ownerId === ownerId),
  save: async (item: MemoryItem) => { bank.set(item.id, item); },
  index: async (items: MemoryItem[]) => {
    if (indexFails) throw indexFails;
    indexed.push(items.map((item) => item.id));
  },
  unindex: async (_ownerId: string, ids: string[]) => { unindexed.push(...ids); },
};

const down = new DependencyDownError('tei', '2026-11-21T10:00:00.000Z', 'its pod is not ready');
const writer = () => createMemoryWriter({ store, now: () => 'now', newId: () => 'new-1' });

beforeEach(() => {
  bank = new Map([['m1', dnsMemory({})]]);
  indexed = [];
  unindexed = [];
  indexFails = undefined;
});

describe('the one memory writer', () => {
  it('indexes a memory as it is written, so the next run recalls it', async () => {
    const outcome = await writer().save({ ownerId: 'u1', text: 'Builds run on the GPU box.' });

    expect(outcome).toMatchObject({ saved: { id: 'new-1' } });
    expect(outcome).not.toHaveProperty('unindexed');
    expect(indexed).toEqual([['new-1']]);
    expect(bank.get('new-1')?.indexPending).toBeUndefined();
  });

  it('keeps a memory written while the index is down, says so with since and why, and marks it for the index\'s recovery', async () => {
    indexFails = down;

    const outcome = await writer().save({ ownerId: 'u1', text: 'Builds run on the GPU box.' });

    expect(outcome).toMatchObject({ saved: { id: 'new-1' }, unindexed: down.message });
    expect(bank.get('new-1')?.indexPending).toBe(true);
  });

  it('says what the index refused when it refuses for good, and keeps the memory marked for indexing', async () => {
    indexFails = new Error('Quickwit refused: HTTP 400 bad document');

    await expect(writer().save({ ownerId: 'u1', text: 'Builds run on the GPU box.' })).rejects.toThrow('Quickwit refused: HTTP 400 bad document');
    expect(bank.get('new-1')?.indexPending).toBe(true);
  });

  it('indexes the new memory when it replaces another, and takes the old one out of the index', async () => {
    await writer().save({ ownerId: 'u1', text: 'DNS moved to Porkbun.', replaces: 'm1' });

    expect(unindexed).toEqual(['m1']);
    expect(indexed).toEqual([['new-1']]);
  });

  it('keeps and indexes what the keeper and the page change, in one call per batch', async () => {
    const changed = [dnsMemory({ id: 'm2', title: 'Mail' }), dnsMemory({ id: 'm3', title: 'Backups' })];

    expect(await writer().keep(changed)).toEqual({});
    expect([...bank.keys()].sort()).toEqual(['m1', 'm2', 'm3']);
    expect(indexed).toEqual([['m2', 'm3']]);
  });

  it('indexes only what recall can find: a retired or unreviewed memory is kept and left out of the index', async () => {
    await writer().keep([dnsMemory({ id: 'm2', invalidAt: 'now' }), dnsMemory({ id: 'm3', status: 'pending_review' })]);

    expect(indexed).toEqual([]);
    expect(bank.get('m2')).toBeDefined();
    expect(bank.get('m3')).toBeDefined();
  });

  it('takes what is retired out of the index before keeping it retired', async () => {
    await writer().retire('u1', [{ ...dnsMemory({}), invalidAt: 'now' }]);

    expect(unindexed).toEqual(['m1']);
    expect(bank.get('m1')?.invalidAt).toBe('now');
  });

  it('retires nothing the index will not let go of, and says why', async () => {
    const refusing = createMemoryWriter({ store: { ...store, unindex: async () => { throw down; } }, now: () => 'now' });

    await expect(refusing.retire('u1', [{ ...dnsMemory({}), invalidAt: 'now' }])).rejects.toThrow(down.message);
    expect(bank.get('m1')?.invalidAt).toBeUndefined();
  });
});

describe('indexing on the index\'s recovery', () => {
  it('indexes what waits each time any piece of the index answers, and waits for the next answer when a piece is still down', async () => {
    const waiting: Partial<Record<string, () => Promise<void> | void>> = {};
    let runs = 0;
    indexOnRecovery({ whenAnswering: (dependency, heard) => { waiting[dependency] = heard; } }, async () => { runs += 1; if (runs === 1) throw down; return 1; });

    expect(Object.keys(waiting).sort()).toEqual(['qdrant', 'quickwit', 'tei']);
    await expect(waiting.tei!()).resolves.toBeUndefined();
    await waiting.qdrant!();
    expect(runs).toBe(2);
  });
});

describe('indexing what was written while the index was down', () => {
  it('indexes every memory marked for it, of every person, and clears the mark', async () => {
    bank.set('m2', dnsMemory({ id: 'm2', ownerId: 'u2', indexPending: true }));
    bank.set('m3', dnsMemory({ id: 'm3', indexPending: true }));

    expect(await indexPendingMemories(store)).toBe(2);
    expect(indexed).toEqual([['m2', 'm3']]);
    expect(bank.get('m2')?.indexPending).toBeUndefined();
    expect(bank.get('m3')?.indexPending).toBeUndefined();
  });

  it('keeps the marks when the index goes down again before it is done', async () => {
    bank.set('m2', dnsMemory({ id: 'm2', indexPending: true }));
    indexFails = down;

    await expect(indexPendingMemories(store)).rejects.toThrow(down.message);
    expect(bank.get('m2')?.indexPending).toBe(true);
  });

  it('marks nothing to index once a pending memory was retired, and clears its mark', async () => {
    bank.set('m2', dnsMemory({ id: 'm2', indexPending: true, invalidAt: 'now' }));

    expect(await indexPendingMemories(store)).toBe(0);
    expect(indexed).toEqual([]);
    expect(bank.get('m2')?.indexPending).toBeUndefined();
  });
});
