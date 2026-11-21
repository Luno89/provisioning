import { describe, expect, it } from 'vitest';
import type { DeferredConclusion, KeeperSettings } from '../lib/conclusions.js';
import type { KeepingState } from '../services/memory-keeping.js';
import type { MemoryItem } from '../lib/memory-store.js';
import type { MemoryStore } from '../store.js';

const memory = (id: string, ownerId: string, extra: Partial<MemoryItem> = {}): MemoryItem => ({
  id,
  ownerId,
  category: 'lessons_learned',
  title: `title ${id}`,
  text: `text ${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const deferred = (id: string, ownerId: string, at: string): DeferredConclusion => ({
  id,
  ownerId,
  at,
  conclusion: { ownerId, runId: `run-${id}`, message: `message ${id}` },
});

export function memoryStoreContract(make: () => Promise<MemoryStore>): void {
  describe('what Koala remembers', () => {
    it('keeps a memory as it was saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      const full = memory('m1', 'owner-1', {
        projectId: 'project-1',
        model: 'provider.model',
        status: 'trial',
        trial: { checkedAt: '2026-10-02T00:00:00.000Z', scenarios: ['a', 'b'] },
        provenance: { taskId: 'task-1', sources: { classes: ['file'], hosts: ['example.com'], runs: [] } },
        useCount: 3,
      });
      await store.saveMemory(full);
      await store.saveMemory(memory('m2', 'owner-1'));
      expect(await store.getMemories()).toEqual([full, memory('m2', 'owner-1')]);
      await store.saveMemory(memory('m1', 'owner-1', { title: 'renamed' }));
      const replaced = (await store.getMemories()).find((stored) => stored.id === 'm1');
      expect(replaced).toEqual(memory('m1', 'owner-1', { title: 'renamed' }));
      expect(replaced).not.toHaveProperty('trial');
      await store.deleteMemory('m1');
      expect((await store.getMemories()).map((stored) => stored.id)).toEqual(['m2']);
    });

    it('lists one person\'s memories, or everyone\'s when no one is named', async () => {
      const store = await make();
      await store.saveMemory(memory('a1', 'ann'));
      await store.saveMemory(memory('b1', 'bob'));
      await store.saveMemory(memory('a2', 'ann'));
      expect((await store.getMemories('ann')).map((stored) => stored.id).sort()).toEqual(['a1', 'a2']);
      expect((await store.getMemories('bob')).map((stored) => stored.id)).toEqual(['b1']);
      expect((await store.getMemories('nobody'))).toEqual([]);
      expect((await store.getMemories()).map((stored) => stored.id).sort()).toEqual(['a1', 'a2', 'b1']);
    });

    it('deleting a memory it does not have changes nothing', async () => {
      const store = await make();
      await store.saveMemory(memory('m1', 'owner-1'));
      await store.deleteMemory('never');
      expect((await store.getMemories()).map((stored) => stored.id)).toEqual(['m1']);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveMemory(memory('m1', 'owner-1', { trial: { checkedAt: 'x', scenarios: ['one'] } }));
      const [read] = await store.getMemories();
      read!.title = 'changed';
      read!.trial!.scenarios!.push('two');
      const [again] = await store.getMemories();
      expect(again?.title).toBe('title m1');
      expect(again?.trial?.scenarios).toEqual(['one']);
    });
  });

  describe('the memory keeper\'s settings', () => {
    it('keeps each person\'s settings apart and replaces them when saved again', async () => {
      const store = await make();
      expect(await store.getKeeperSettings('ann')).toBeUndefined();
      const ann: KeeperSettings = { ownerId: 'ann', paused: true, updatedAt: '2026-10-01T00:00:00.000Z' };
      await store.saveKeeperSettings(ann);
      await store.saveKeeperSettings({ ownerId: 'bob', paused: false, updatedAt: '2026-10-02T00:00:00.000Z' });
      expect(await store.getKeeperSettings('ann')).toEqual(ann);
      expect((await store.getKeeperSettings('bob'))?.paused).toBe(false);
      await store.saveKeeperSettings({ ...ann, paused: false });
      expect(await store.getKeeperSettings('ann')).toEqual({ ...ann, paused: false });
    });

    it('hands back a copy of the settings', async () => {
      const store = await make();
      await store.saveKeeperSettings({ ownerId: 'ann', paused: true, updatedAt: 'x' });
      const read = await store.getKeeperSettings('ann');
      read!.paused = false;
      expect((await store.getKeeperSettings('ann'))?.paused).toBe(true);
    });
  });

  describe('conclusions held back while the keeper is paused', () => {
    it('lists a person\'s held conclusions oldest first, and no one else\'s', async () => {
      const store = await make();
      await store.saveDeferredConclusion(deferred('d3', 'ann', '2026-10-03T00:00:00.000Z'));
      await store.saveDeferredConclusion(deferred('d1', 'ann', '2026-10-01T00:00:00.000Z'));
      await store.saveDeferredConclusion(deferred('x1', 'bob', '2026-10-01T12:00:00.000Z'));
      await store.saveDeferredConclusion(deferred('d2', 'ann', '2026-10-02T00:00:00.000Z'));
      expect((await store.getDeferredConclusions('ann')).map((entry) => entry.id)).toEqual(['d1', 'd2', 'd3']);
      expect((await store.getDeferredConclusions('bob')).map((entry) => entry.id)).toEqual(['x1']);
      expect(await store.getDeferredConclusions('nobody')).toEqual([]);
    });

    it('keeps a conclusion whole, and saving the same one again replaces it', async () => {
      const store = await make();
      const held = { ...deferred('d1', 'ann', '2026-10-01T00:00:00.000Z'), conclusion: { ownerId: 'ann', runId: 'r', message: 'm', about: 'a', projectId: 'p', heardOthers: true } };
      await store.saveDeferredConclusion(held);
      expect(await store.getDeferredConclusions('ann')).toEqual([held]);
      await store.saveDeferredConclusion({ ...held, at: '2026-10-05T00:00:00.000Z' });
      expect(await store.getDeferredConclusions('ann')).toEqual([{ ...held, at: '2026-10-05T00:00:00.000Z' }]);
    });

    it('removes a conclusion only for the person it belongs to', async () => {
      const store = await make();
      await store.saveDeferredConclusion(deferred('d1', 'ann', '2026-10-01T00:00:00.000Z'));
      await store.deleteDeferredConclusion('bob', 'd1');
      expect((await store.getDeferredConclusions('ann')).map((entry) => entry.id)).toEqual(['d1']);
      await store.deleteDeferredConclusion('ann', 'never');
      await store.deleteDeferredConclusion('ann', 'd1');
      expect(await store.getDeferredConclusions('ann')).toEqual([]);
    });
  });

  describe('how each person\'s last consolidation went', () => {
    it('keeps each person\'s state apart, replaces it whole when saved again, and has none for someone never consolidated', async () => {
      const store = await make();
      expect(await store.getKeepingState('ann')).toBeUndefined();
      const down: KeepingState = { ownerId: 'ann', state: 'down', since: '2026-10-01T00:00:00.000Z', reason: 'Qdrant "vectors" is deployed but not answering', at: '2026-10-02T00:00:00.000Z' };
      await store.saveKeepingState(down);
      await store.saveKeepingState({ ownerId: 'bob', state: 'kept', at: '2026-10-02T00:00:00.000Z' });
      expect(await store.getKeepingState('ann')).toEqual(down);
      await store.saveKeepingState({ ownerId: 'ann', state: 'kept', at: '2026-10-03T00:00:00.000Z' });
      expect(await store.getKeepingState('ann')).toEqual({ ownerId: 'ann', state: 'kept', at: '2026-10-03T00:00:00.000Z' });
      expect(await store.getKeepingState('bob')).toEqual({ ownerId: 'bob', state: 'kept', at: '2026-10-02T00:00:00.000Z' });
    });
  });

  describe('what the keeper has already read', () => {
    it('remembers a mark by its key, replaces it, and has none for a key it never saw', async () => {
      const store = await make();
      expect(await store.getMemoryWatermark('conversation:c1')).toBeUndefined();
      await store.saveMemoryWatermark('conversation:c1', '2026-10-01T00:00:00.000Z');
      await store.saveMemoryWatermark('conversation:c2', 'other');
      expect(await store.getMemoryWatermark('conversation:c1')).toBe('2026-10-01T00:00:00.000Z');
      await store.saveMemoryWatermark('conversation:c1', '2026-10-09T00:00:00.000Z');
      expect(await store.getMemoryWatermark('conversation:c1')).toBe('2026-10-09T00:00:00.000Z');
      expect(await store.getMemoryWatermark('conversation:c2')).toBe('other');
    });
  });
}
