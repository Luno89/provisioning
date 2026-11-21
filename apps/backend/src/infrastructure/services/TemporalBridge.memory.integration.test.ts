import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { testDataDir } from '../../platform/testing/data-dir.js';
import { startCorpusStandIn, type CorpusStandIn } from '../../engine/testing/corpus-stand-in.js';
import { MEMORY_INDEX } from '../../memory/lib/memory-rank.js';
import { TemporalBridge } from './TemporalBridge.js';

const KEY = 'bridge-memory-key' as never;

let standIn: CorpusStandIn;
beforeAll(async () => { standIn = await startCorpusStandIn(); });
afterAll(async () => { await standIn.stop(); });

const lesson = (id: string, ownerId: string, days: number) => ({
  id, ownerId, category: 'environment_facts' as const, scope: 'global' as const, status: 'active' as const, title: 'DNS lives at Cloudflare', text: 'The person manages DNS at Cloudflare.',
  createdAt: new Date(Date.now() - days * 86_400_000).toISOString(), updatedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
});

describe('the bridge\'s pass over everyone\'s memories, on Mongo', () => {
  it('retires each person\'s own duplicates, indexes what is left in the memory index, and keeps what the pass found', async () => {
    const db = await testDatabase();
    const bridge = new TemporalBridge(db, testDataDir(), undefined, KEY, undefined, { memoryIndex: standIn.reach });
    for (const item of [lesson('a1', 'u1', 8), lesson('a2', 'u1', 6), lesson('b1', 'u2', 7)]) await db.memory.saveMemory(item);

    await bridge.consolidateMemoryBank();

    expect((await db.memory.getMemories()).map((item) => [item.id, item.mergedInto ?? item.supersededBy ?? 'current']).sort()).toEqual([['a1', 'a2'], ['a2', 'current'], ['b1', 'current']]);
    expect(standIn.documents(MEMORY_INDEX).map((doc) => doc.memory_id)).toContain('b1');
    expect(bridge.lastConsolidation?.indexed).toBeGreaterThan(0);
  });
});
