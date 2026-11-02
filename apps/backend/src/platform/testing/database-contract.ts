import { describe, expect, it } from 'vitest';
import type { Database } from '../lib/db-interface.js';

const at = '2026-11-02T00:00:00.000Z';

export function databaseContract(make: () => Promise<Database>): void {
  describe('one database the areas share', () => {
    it('shows the hub a tree, a story and a conversation saved through their own areas', async () => {
      const db = await make();
      await db.projects.saveTree({ id: 'tree-1', ownerId: 'owner-1', name: 'Shop', createdAt: at, updatedAt: at } as never);
      await db.projects.saveLeaf({ id: 'leaf-1', treeId: 'tree-1', branchId: 'branch-1', title: 'Checkout', status: 'pending', createdAt: at, updatedAt: at } as never);
      await db.engine.saveConversation({ id: 'chat-1', ownerId: 'owner-1', title: 'Talk', messages: [], createdAt: at, updatedAt: at } as never);
      expect(await db.hub.syncedRecord('trees', 'tree-1')).toMatchObject({ id: 'tree-1', name: 'Shop' });
      expect(await db.hub.syncedRecord('leaves', 'leaf-1')).toMatchObject({ id: 'leaf-1', title: 'Checkout' });
      expect(await db.hub.syncedRecord('conversations', 'chat-1')).toMatchObject({ id: 'chat-1', title: 'Talk' });
    });

    it('lets each area read what the hub wrote, and forget what it deleted', async () => {
      const db = await make();
      await db.projects.saveTree({ id: 'tree-1', ownerId: 'owner-1', name: 'Shop', createdAt: at, updatedAt: at } as never);
      await db.hub.patchSyncedRecord('trees', 'tree-1', { set: { name: 'Shop on the hub' } });
      await db.hub.patchSyncedRecord('trees', 'tree-2', { set: { ownerId: 'owner-1', name: 'Made on the hub', createdAt: at, updatedAt: at } });
      expect((await db.projects.getTrees()).map((tree) => [tree.id, tree.name]).sort()).toEqual([['tree-1', 'Shop on the hub'], ['tree-2', 'Made on the hub']]);
      await db.hub.deleteSyncedRecord('trees', 'tree-1');
      expect((await db.projects.getTrees()).map((tree) => tree.id)).toEqual(['tree-2']);
    });
  });
}
