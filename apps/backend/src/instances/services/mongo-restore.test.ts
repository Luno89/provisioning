import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { Collection, Db, MongoClient } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { restoreMongo } from './mongo-restore.js';

afterEach(() => { vi.useRealTimers(); });

const gzipped = (...lines: object[]) => Readable.from([zlib.gzipSync(lines.map((line) => `${JSON.stringify(line)}\n`).join(''))]);

describe('restoring a moved instance\'s Mongo', () => {
  it('waits for this machine\'s Mongo to answer, saying why, then replaces the database with every record carried', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const inserted: string[] = [];
    const collection = mock<Collection>();
    collection.insertMany.mockImplementation(async (docs) => { inserted.push(...docs.map((doc) => String(doc._id))); return { acknowledged: true, insertedCount: docs.length, insertedIds: {} }; });
    const db = mock<Db>();
    db.dropDatabase.mockResolvedValue(true);
    db.collection.mockReturnValue(collection);
    const client = mock<MongoClient>();
    client.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:27017')).mockResolvedValue(client);
    client.db.mockReturnValue(db);
    const waits: string[] = [];
    const restoring = restoreMongo({ uri: 'mongodb://127.0.0.1/koala', dbName: 'koala' }, gzipped({ c: 'projects', d: { _id: 'p1' } }, { c: 'projects', d: { _id: 'p2' } }), (why) => waits.push(why), () => client);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await restoring).toBe(2);
    expect(waits).toEqual(['connect ECONNREFUSED 127.0.0.1:27017']);
    expect(db.dropDatabase).toHaveBeenCalledOnce();
    expect(inserted).toEqual(['p1', 'p2']);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('closes the connection when a record cannot be read', async () => {
    const db = mock<Db>();
    db.dropDatabase.mockResolvedValue(true);
    const client = mock<MongoClient>();
    client.connect.mockResolvedValue(client);
    client.db.mockReturnValue(db);
    const broken = Readable.from([zlib.gzipSync('not json\n')]);
    await expect(restoreMongo({ uri: 'mongodb://127.0.0.1/koala', dbName: 'koala' }, broken, undefined, () => client)).rejects.toThrow(SyntaxError);
    expect(client.close).toHaveBeenCalledOnce();
  });
});
