import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { clientOptionsFor } from './collection.js';
import { REPLICA_SET_NEEDED, ensureReplicaSet } from './replica-set.js';

const started: MongoMemoryServer[] = [];
const clients: MongoClient[] = [];

async function connected(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, clientOptionsFor(uri));
  clients.push(client);
  return client.connect();
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of started.splice(0)) await server.stop();
});

describe('a Mongo Koala follows changes on', () => {
  it('is made a replica set the first time Koala connects, by whichever process gets there first, and then serves change streams', async () => {
    const server = await MongoMemoryServer.create({ instance: { replSet: 'koala' } });
    started.push(server);
    const [first, second] = await Promise.all([connected(server.getUri()), connected(server.getUri())]);

    await Promise.all([ensureReplicaSet(first), ensureReplicaSet(second)]);

    const hello = await first.db('admin').command({ hello: 1 });
    expect(hello).toMatchObject({ setName: 'koala', isWritablePrimary: true });
    const records = first.db('koala').collection('deployments');
    const stream = records.watch();
    const changed = stream.next();
    await second.db('koala').collection('deployments').insertOne({ _id: 'shop' as never, status: 'deploying' });
    expect(await changed).toMatchObject({ operationType: 'insert', documentKey: { _id: 'shop' } });
    await stream.close();
  });

  it('is refused, saying how to start it, when it runs on its own', async () => {
    const server = await MongoMemoryServer.create();
    started.push(server);

    await expect(ensureReplicaSet(await connected(server.getUri()))).rejects.toThrow(REPLICA_SET_NEEDED);
  });

  it('is left as it is once it is one', async () => {
    const client = await connected(inject('mongoUri'));

    await ensureReplicaSet(client);

    expect(await client.db('admin').command({ hello: 1 })).toMatchObject({ setName: 'rs0', isWritablePrimary: true });
  });
});
