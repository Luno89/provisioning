import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Collection, Db, MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { restoreMongo } from './mongo-restore.js';

const gzipped = (text: string) => Readable.from([zlib.gzipSync(text)]);

describe('restoring a moved instance\'s Mongo', () => {
  it('replaces the database with every record carried, collection by collection', async () => {
    const inserted: string[] = [];
    const collection = mock<Collection>();
    collection.insertMany.mockImplementation(async (docs) => { inserted.push(...docs.map((doc) => String(doc._id))); return { acknowledged: true, insertedCount: docs.length, insertedIds: {} }; });
    const db = mock<Db>();
    db.dropDatabase.mockResolvedValue(true);
    db.collection.mockReturnValue(collection);
    const client = mock<MongoClient>();
    client.db.mockReturnValue(db);
    const lines = [{ c: 'projects', d: { _id: 'p1' } }, { c: 'projects', d: { _id: 'p2' } }].map((line) => `${JSON.stringify(line)}\n`).join('');
    expect(await restoreMongo(client, 'koala', gzipped(lines))).toBe(2);
    expect(client.db).toHaveBeenCalledWith('koala');
    expect(db.dropDatabase).toHaveBeenCalledOnce();
    expect(inserted).toEqual(['p1', 'p2']);
  });

  it('fails on a record it cannot read', async () => {
    const db = mock<Db>();
    db.dropDatabase.mockResolvedValue(true);
    const client = mock<MongoClient>();
    client.db.mockReturnValue(db);
    await expect(restoreMongo(client, 'koala', gzipped('not json\n'))).rejects.toThrow(SyntaxError);
  });
});
