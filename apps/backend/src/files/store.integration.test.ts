import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { loadKeys } from '../platform/lib/keys.js';
import { shareTokenHash, type FileShare } from './lib/file-shares.js';
import { MongoFilesStore } from './store.js';

const key = loadKeys({ DATA_KEY: 'k'.repeat(64) }).data;
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

const share = (id: string, token: string, extra: Partial<FileShare> = {}): FileShare => ({
  id, token, ownerId: 'u1', path: 'a.pdf', name: 'a.pdf', createdAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z', ...extra,
});

describe('the files store keeps a share link\'s token only as its hash and sealed', () => {
  let client: MongoClient;
  let db: Db;
  let store: MongoFilesStore;

  beforeAll(async () => {
    client = await MongoClient.connect(inject('mongoUri'));
    db = client.db(`t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
    store = new MongoFilesStore(() => db, key);
    await store.ensureIndexes();
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  it('finds a link by its token, while the database holds no token in the clear', async () => {
    await store.saveFileShare(share('s1', TOKEN));
    const stored = JSON.stringify(await db.collection('fileShares').findOne({ _id: 's1' as never }));
    expect(stored).not.toContain(TOKEN);
    expect(looksEncrypted(String((await db.collection('fileShares').findOne({ _id: 's1' as never }))?.token))).toBe(true);
    expect(await store.getFileShareByToken(TOKEN)).toMatchObject({ id: 's1', token: TOKEN, path: 'a.pdf' });
    expect(await store.getFileShareByToken('s1')).toBeUndefined();
    expect((await store.getFileShares('u1')).map((entry) => entry.token)).toEqual([TOKEN]);
    await store.deleteFileShare('s1');
    expect(await store.getFileShareByToken(TOKEN)).toBeUndefined();
  });

  it('moves a link stored under its token to an id of its own once, and it opens the same', async () => {
    const old = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    await db.collection('fileShares').insertOne({ _id: old as never, ownerId: 'u2', path: 'b.pdf', name: 'b.pdf', createdAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z' });
    expect(await store.getFileShare(old)).toBeUndefined();
    expect(await store.sealShareTokens()).toBe(1);
    expect(await db.collection('fileShares').findOne({ _id: old as never })).toBeNull();
    const moved = await store.getFileShareByToken(old);
    expect(moved).toMatchObject({ token: old, ownerId: 'u2', path: 'b.pdf' });
    expect(moved?.id).not.toBe(old);
    expect(await db.collection('fileShares').countDocuments({ tokenHash: shareTokenHash(old) })).toBe(1);
    expect(await store.sealShareTokens()).toBe(0);
  });
});
