import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterEach, describe, expect, it } from 'vitest';
import { clientOptionsFor } from '../platform/lib/collection.js';
import { testDatabaseAt } from '../platform/lib/test-database.js';
import { restoreMongoInto } from './move-import.js';

const started: MongoMemoryServer[] = [];
afterEach(async () => { for (const server of started.splice(0)) await server.stop(); });

describe('the move\'s Mongo step on the new machine', () => {
  it('restores what root carried into this machine\'s Mongo and leaves no connection open', async () => {
    const { db, uri, dbName } = await testDatabaseAt();
    const carried = [{ c: 'projects', d: { _id: 'p1', id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } }].map((line) => `${JSON.stringify(line)}\n`).join('');
    const said: string[] = [];
    expect(await restoreMongoInto({ uri, dbName }, Readable.from([zlib.gzipSync(carried)]), (line) => said.push(line))).toBe(1);
    expect((await db.projects.getProjects()).map((project) => project.name)).toEqual(['Shop']);
    expect(said).toEqual([]);
  });

  it('waits for a Mongo whose replica set has no primary yet, as a new machine\'s first start has, and restores into it', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const carried = `${JSON.stringify({ c: 'projects', d: { _id: 'p1', id: 'p1', name: 'Shop', ownerId: 'bo', createdAt: 't' } })}\n`;

    expect(await restoreMongoInto({ uri: server.getUri(), dbName: 'koala' }, Readable.from([zlib.gzipSync(carried)]), () => undefined)).toBe(1);

    const reader = new MongoClient(server.getUri(), clientOptionsFor(server.getUri()));
    try {
      expect((await reader.db('koala').collection<{ name: string }>('projects').find().toArray()).map((project) => project.name)).toEqual(['Shop']);
    } finally {
      await reader.close();
    }
  });
});
