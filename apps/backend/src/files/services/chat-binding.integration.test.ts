import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { testDatabaseAt } from '../../platform/lib/test-database.js';
import { storedFilesOn } from '../testing/stored-files-twin.js';
import { bindChatWithItsFiles } from './chat-binding.js';

const chat = { id: 'c1', ownerId: 'bo', title: 'plan the shop', messages: [], createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z' };

describe('a chat becoming a project\'s on a real Mongo replica set', () => {
  it('binds and moves in one transaction: when the move fails, the chat is not bound and its files stay', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    const { files } = storedFilesOn(db.files);
    await db.engine.saveConversation(chat as never);
    for (const name of ['a.txt', 'b.txt']) await files.at('bo', { kind: 'conversation', id: 'c1' }).upload(name, Readable.from([Buffer.from(name)]), name.length, 'text/plain', { replace: true });
    const client = await MongoClient.connect(uri);
    try {
      await client.db(dbName).command({ collMod: 'storedFiles', validator: { path: { $ne: 'chats/c1/b.txt' } }, validationAction: 'error' });
      await expect(bindChatWithItsFiles(db)('bo', 'c1', { treeId: 't1', projectId: 'p1' })).rejects.toThrow('Document failed validation');
      expect((await db.engine.getConversation('bo', 'c1'))?.treeId).toBeUndefined();
      const stayed = await files.at('bo', { kind: 'conversation', id: 'c1' }).list('');
      expect(stayed.ok && stayed.value.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
      await client.db(dbName).command({ collMod: 'storedFiles', validator: {} });
      expect(await bindChatWithItsFiles(db)('bo', 'c1', { treeId: 't1', projectId: 'p1' })).toBe(true);
      expect((await db.engine.getConversation('bo', 'c1'))).toMatchObject({ treeId: 't1', projectId: 'p1' });
      const moved = await files.at('bo', { kind: 'project', id: 'p1' }).list('chats/c1');
      expect(moved.ok && moved.value.map((entry) => entry.path)).toEqual(['chats/c1/a.txt', 'chats/c1/b.txt']);
    } finally {
      await client.close();
    }
  });
});
