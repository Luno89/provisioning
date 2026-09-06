import { describe, it, expect, vi } from 'vitest';
import { createMemoryAdmitter, recallLeafMemory } from './leaf-memory-admit.js';

const endpoints = { corpus: 'http://corpus', embed: 'http://embed' } as any;

describe('createMemoryAdmitter', () => {
  it('saves what admitMemory decides to write and reports the decision', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const admit = createMemoryAdmitter({
      db, ownerId: 'u1', leafId: 'l1', memoryEndpoints: async () => endpoints, ask: vi.fn(async () => 'NOOP'),
    });

    const decision = await admit({
      id: 'm1', ownerId: 'u1', category: 'lessons_learned', title: 'Lesson', text: 'body',
      status: 'active', source: 'agent_tool', createdAt: '', updatedAt: '',
    } as any);

    expect(decision.action).toBe('ADD');
    expect(db.saveMemory).toHaveBeenCalled();
  });

  it('consults existing memories for the same owner as neighbours before deciding', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const admit = createMemoryAdmitter({
      db, ownerId: 'u1', leafId: 'l1', memoryEndpoints: async () => endpoints, ask: vi.fn(async () => 'NOOP'),
    });

    await admit({
      id: 'candidate', ownerId: 'u1', category: 'lessons_learned', title: 'New', text: 'body',
      status: 'active', source: 'agent_tool', createdAt: '', updatedAt: '',
    } as any);

    expect(db.getMemories).toHaveBeenCalledWith('u1');
  });
});

describe('recallLeafMemory', () => {
  it('recalls nothing from an empty memory bank without throwing', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    const out = await recallLeafMemory({ db, memoryEndpoints: async () => endpoints }, {
      id: 'l1', title: 'Do the thing', ownerId: 'u1',
    }, undefined);
    expect(out.selected).toEqual([]);
  });

  it('reads from the owner\'s own memory bank', async () => {
    const db = { getMemories: vi.fn(async () => []), saveMemory: vi.fn(async () => undefined) };
    await recallLeafMemory({ db, memoryEndpoints: async () => endpoints }, {
      id: 'l1', title: 'Do the thing', ownerId: 'u1',
    }, undefined);
    expect(db.getMemories).toHaveBeenCalledWith('u1');
  });
});
