import { describe, expect, it } from 'vitest';
import type { ToolHandlerContext } from '@koala/engine-core';
import { testDatabase } from '../../platform/lib/test-database.js';
import { dnsMemory } from '../../memory/testing/memories.js';
import { storesFromDatabase } from '../host.js';
import { createMemoryTools } from './memory-tools.js';

describe('searching memories while a project is deleted', () => {
  it('leaves out what is remembered for that project alone from the mark until Restore, and finds it again after', async () => {
    const db = await testDatabase();
    const stores = storesFromDatabase(db, {
      index: async () => undefined,
      unindex: async () => undefined,
      search: async (ownerId) => (await db.memory.getMemories(ownerId)).map((memory) => memory.id),
    });
    await db.projects.saveProject({ id: 'shop', name: 'shop', ownerId: 'u1', appType: 'gitapp', createdAt: 'then' });
    await db.memory.saveMemory(dnsMemory({ id: 'everywhere', projectId: 'shop' }));
    await db.memory.saveMemory(dnsMemory({ id: 'shop-only', scope: 'project', projectId: 'shop', title: 'The shop deploys on Fridays', text: 'Deploy the shop on Fridays only.' }));
    const search = async () => {
      const tools = createMemoryTools({ store: stores.memories });
      const found = await tools.search_memories!({ name: 'search_memories', parsed: { query: 'deploys' }, driver: undefined, caller: { ownerId: 'u1', runId: 'run-1' } } as ToolHandlerContext);
      return found.content ?? '';
    };

    expect(await search()).toContain('id shop-only');
    await db.projects.markDeleting('shop', { startedAt: 'then', requestedBy: 'u1', mode: 'archive' });
    expect(await search()).not.toContain('id shop-only');
    await db.projects.archive('shop');
    const archived = await search();
    expect(archived).not.toContain('id shop-only');
    expect(archived).toContain('id everywhere');
    await db.projects.restore('shop', 'shop');
    expect(await search()).toContain('id shop-only');
  });
});
