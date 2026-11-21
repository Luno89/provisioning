import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseMongo, type MongoLease } from '../lib/mongo-lease.js';
import { MongoPlatformStore } from '../store.js';
import { holdFencesIn } from './fences.js';

const started: MongoMemoryServer[] = [];
const leases: MongoLease[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.release();
  for (const server of started.splice(0)) await server.stop();
});

describe('a worker holding the fences as it starts', () => {
  it('waits for a Mongo whose replica set has no primary yet, as an instance\'s first start has, and is then live', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const mongo = { uri: server.getUri(), dbName: 'koala' };

    const watch = await holdFencesIn('worker-engine', mongo);

    const reader = await leaseMongo(mongo.uri);
    leases.push(reader);
    const store = new MongoPlatformStore(() => reader.client.db(mongo.dbName));
    expect((await store.processesSeenSince(new Date(0).toISOString())).map((row) => row.name)).toEqual(['worker-engine']);
    await watch.stop();
  });

  it('sets up the fences it follows itself, on a database no other process has set up, so a worker can be the first to start', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const mongo = { uri: server.getUri(), dbName: 'fresh' };

    const watch = await holdFencesIn('worker-cluster', mongo);

    const reader = await leaseMongo(mongo.uri);
    leases.push(reader);
    const [fences] = await reader.client.db(mongo.dbName).listCollections({ name: 'fences' }).toArray();
    expect((fences as { options?: { changeStreamPreAndPostImages?: unknown } } | undefined)?.options?.changeStreamPreAndPostImages).toEqual({ enabled: true });
    await watch.stop();
  });
});
