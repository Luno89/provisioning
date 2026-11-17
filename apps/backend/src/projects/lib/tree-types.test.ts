import { describe, it, expect, vi } from 'vitest';
import { MemoryProjectsStore } from '../testing/memory-store.js';
import { resolveTreeType, seedTreeTypes } from './tree-types.js';

const unanswering = () => {
  const store = new MemoryProjectsStore();
  vi.spyOn(store, 'getTreeTypes').mockRejectedValue(new Error('the database is not answering'));
  return store;
};

describe('a tree type read from a store that fails', () => {
  it('a store that does not answer is not read as no tree type', async () => {
    await expect(resolveTreeType(unanswering(), 'u1', 'odoo')).rejects.toThrow('the database is not answering');
  });

  it('seeding over a store that does not answer writes nothing and says why', async () => {
    const store = unanswering();
    const save = vi.spyOn(store, 'saveTreeType');

    await expect(seedTreeTypes(store)).rejects.toThrow('the database is not answering');
    expect(save).not.toHaveBeenCalled();
  });
});
