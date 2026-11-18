import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterEach, describe, expect, it } from 'vitest';
import { clientOptionsFor } from '../lib/collection.js';
import { MongoPlatformStore } from '../store.js';
import { holdFencesIn } from './fences.js';

const started: MongoMemoryServer[] = [];
const clients: MongoClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of started.splice(0)) await server.stop();
});

describe('a worker holding the fences as it starts', () => {
  it('waits for a Mongo whose replica set has no primary yet, as an instance\'s first start has, and is then live', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const mongo = { uri: server.getUri(), dbName: 'koala' };

    const watch = await holdFencesIn('worker-engine', mongo);

    const reader = new MongoClient(mongo.uri, clientOptionsFor(mongo.uri));
    clients.push(reader);
    const store = new MongoPlatformStore(() => reader.db(mongo.dbName));
    expect((await store.processesSeenSince(new Date(0).toISOString())).map((row) => row.name)).toEqual(['worker-engine']);
    await watch.stop();
  });
});
