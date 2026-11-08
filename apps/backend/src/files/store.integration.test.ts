import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { loadKey } from '../platform/lib/keys.js';
import { shareTokenHash, type FileShare } from './lib/file-shares.js';
import { MongoFilesStore } from './store.js';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import { filesStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

filesStoreContract(async () => (await fresh()).files);

const key = loadKey({ DATA_KEY: 'k'.repeat(64) }, 'data');
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

describe('the records of stored files on a real Mongo replica set', () => {
  let client: MongoClient;
  let db: Db;
  let store: MongoFilesStore;
  const AT = '2026-11-07T10:00:00.000Z';
  const scope = { kind: 'project', id: 'p1' } as const;
  const upload = (id: string, path: string) => ({ id, objectId: id, ownerId: 'u1', scope: { ...scope }, path, kind: 'file' as const, size: 0, contentType: 'text/plain', version: 0, madeAt: AT, changedAt: AT, state: 'uploading' as const, touchedAt: AT });

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

  it('lets only one of two uploads racing to the same new path in, when neither may replace', async () => {
    await store.beginStoredFile(upload('r1', 'race.txt'));
    await store.beginStoredFile(upload('r2', 'race.txt'));
    const outcomes = await Promise.allSettled([
      store.commitStoredFiles([{ id: 'r1', size: 1 }], { replace: false }, AT),
      store.commitStoredFiles([{ id: 'r2', size: 1 }], { replace: false }, AT),
    ]);
    const kept = outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.ok);
    expect(kept).toHaveLength(1);
    expect((await store.storedFilesIn('u1', scope)).filter((record) => record.path === 'race.txt')).toHaveLength(1);
  });

  it('leaves every record as it was when a move fails part way through', async () => {
    for (const [id, path] of [['m1', 'dir/a.txt'], ['m2', 'dir/b.txt'], ['m3', 'dir/c.txt']] as const) {
      await store.beginStoredFile(upload(id, path));
      expect((await store.commitStoredFiles([{ id, size: 1 }], { replace: false }, AT)).ok).toBe(true);
    }
    await db.command({ collMod: 'storedFiles', validator: { path: { $ne: 'moved/c.txt' } }, validationAction: 'error' });
    try {
      await expect(store.moveStoredFiles('u1', scope, 'dir', 'moved', AT)).rejects.toThrow('Document failed validation');
    } finally {
      await db.command({ collMod: 'storedFiles', validator: {} });
    }
    const paths = (await store.storedFilesIn('u1', scope)).map((record) => record.path).filter((path) => !path.startsWith('race')).sort();
    expect(paths).toEqual(['dir/a.txt', 'dir/b.txt', 'dir/c.txt']);
  });
});

describe('the artifacts Koala kept in Mongo before, read once for the Archive', () => {
  it('hands each back whole with its owner and run, its pieces in order, then forgets them all', async () => {
    const client = await MongoClient.connect(inject('mongoUri'));
    const db = client.db(`t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
    const store = new MongoFilesStore(() => db, key);
    try {
      await db.collection('artifacts').insertMany([
        { _id: 'a1' as never, ownerId: 'bo', runId: 'run-1', name: 'shot.png', contentType: 'image/png' },
        { _id: 'a2' as never, runId: 'run-2', name: 'orphan.txt' },
      ]);
      await db.collection('artifactChunks').insertMany([
        { _id: 'a1:1' as never, artifactId: 'a1', n: 1, data: Buffer.from('world') },
        { _id: 'a1:0' as never, artifactId: 'a1', n: 0, data: Buffer.from('hello ') },
      ]);
      const read = [];
      for await (const artifact of store.oldArtifacts()) read.push({ ...artifact, bytes: artifact.bytes.toString() });
      expect(read).toEqual([{ ownerId: 'bo', runId: 'run-1', name: 'shot.png', contentType: 'image/png', bytes: 'hello world' }]);
      expect(await store.forgetOldArtifacts()).toBe(2);
      expect(await db.collection('artifacts').countDocuments()).toBe(0);
      expect(await db.collection('artifactChunks').countDocuments()).toBe(0);
      expect(await store.forgetOldArtifacts()).toBe(0);
    } finally {
      await db.dropDatabase();
      await client.close();
    }
  });
});
