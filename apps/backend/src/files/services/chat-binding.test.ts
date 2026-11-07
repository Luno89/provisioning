import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Database, Tx } from '../../platform/index.js';
import { bindChatWithItsFiles } from './chat-binding.js';

const TX: Tx = {};

function world(bound: boolean) {
  const engine = mock<Database['engine']>();
  const files = mock<Database['files']>();
  const order: string[] = [];
  engine.bindConversation.mockImplementation(async () => { order.push('bind'); return bound; });
  files.moveStoredScope.mockImplementation(async () => { order.push('move'); return 2; });
  const db = { engine, files, transaction: async <T>(work: (tx: Tx) => Promise<T>) => { order.push('begin'); const done = await work(TX); order.push('commit'); return done; } };
  return { db, engine, files, order, bind: bindChatWithItsFiles(db, () => '2026-11-07T10:00:00.000Z') };
}

describe('binding a chat to a tree and its project', () => {
  it('binds it and moves its files under chats/<chat> in the project, both in one transaction', async () => {
    const { bind, engine, files, order } = world(true);
    expect(await bind('bo', 'c1', { treeId: 't1', projectId: 'p1' })).toBe(true);
    expect(order).toEqual(['begin', 'bind', 'move', 'commit']);
    expect(engine.bindConversation).toHaveBeenCalledWith('bo', 'c1', { treeId: 't1', projectId: 'p1' }, TX);
    expect(files.moveStoredScope).toHaveBeenCalledWith('bo', { kind: 'conversation', id: 'c1' }, { kind: 'project', id: 'p1' }, 'chats/c1', '2026-11-07T10:00:00.000Z', TX);
  });

  it('moves nothing when the chat was not bound, as when it was bound before', async () => {
    const { bind, files } = world(false);
    expect(await bind('bo', 'c1', { treeId: 't1', projectId: 'p1' })).toBe(false);
    expect(files.moveStoredScope).not.toHaveBeenCalled();
  });

  it('moves nothing when the tree has no project, so the chat keeps its own files', async () => {
    const { bind, files } = world(true);
    expect(await bind('bo', 'c1', { treeId: 't1' })).toBe(true);
    expect(files.moveStoredScope).not.toHaveBeenCalled();
  });

  it('fails as a whole when moving the files fails', async () => {
    const { bind, files, order } = world(true);
    files.moveStoredScope.mockRejectedValue(new Error('write conflict'));
    await expect(bind('bo', 'c1', { treeId: 't1', projectId: 'p1' })).rejects.toThrow('write conflict');
    expect(order).toEqual(['begin', 'bind']);
  });
});
