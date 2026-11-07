import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { storedFilesOn } from '../testing/stored-files-twin.js';
import { bindChatWithItsFiles } from './chat-binding.js';

const chat = (id: string) => ({ id, ownerId: 'bo', title: 'plan the shop', messages: [], createdAt: '2026-11-07T09:00:00.000Z', updatedAt: '2026-11-07T09:00:00.000Z' });

describe('a chat becoming a project\'s, on the in-memory database', () => {
  it('takes the chat\'s files into the project under chats/<chat>, keeping their ids, and drops their share links', async () => {
    const db = memoryDatabase();
    const { files } = storedFilesOn(db.files);
    await db.engine.saveConversation(chat('c1') as never);
    const kept = await files.at('bo', { kind: 'conversation', id: 'c1' }).upload('photo.png', Readable.from([Buffer.from('png')]), 3, 'image/png', { replace: true });
    const id = kept.ok ? kept.value.id : '';
    await db.files.saveFileShare({ id: 's1', token: 'abcdefghijklmnopqrstuvwxyz012345', ownerId: 'bo', fileId: id, path: 'photo.png', name: 'photo.png', createdAt: 'x', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(await bindChatWithItsFiles(db)('bo', 'c1', { treeId: 't1', projectId: 'p1' })).toBe(true);
    const moved = await files.at('bo', { kind: 'project', id: 'p1' }).find('chats/c1/photo.png');
    expect(moved?.id).toBe(id);
    expect(await files.at('bo', { kind: 'conversation', id: 'c1' }).list('')).toEqual({ ok: true, value: [] });
    expect(await db.files.getFileShares('bo')).toEqual([]);
    expect(await bindChatWithItsFiles(db)('bo', 'c1', { treeId: 't2', projectId: 'p2' })).toBe(false);
    expect((await files.at('bo', { kind: 'project', id: 'p1' }).find('chats/c1/photo.png'))?.id).toBe(id);
  });

  it('leaves the chat unbound and its files where they were when the move fails', async () => {
    const db = memoryDatabase();
    const { files } = storedFilesOn(db.files);
    await db.engine.saveConversation(chat('c1') as never);
    await files.at('bo', { kind: 'conversation', id: 'c1' }).upload('a.txt', Readable.from([Buffer.from('a')]), 1, 'text/plain', { replace: true });
    const failing = { ...db, files: { ...db.files, moveStoredScope: async () => { throw new Error('the move failed'); } } } as unknown as typeof db;
    failing.transaction = db.transaction;
    await expect(bindChatWithItsFiles(failing)('bo', 'c1', { treeId: 't1', projectId: 'p1' })).rejects.toThrow('the move failed');
    expect((await db.engine.getConversation('bo', 'c1'))?.treeId).toBeUndefined();
    expect((await files.at('bo', { kind: 'conversation', id: 'c1' }).find('a.txt'))?.path).toBe('a.txt');
  });
});
