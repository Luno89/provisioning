import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';
import { clientOptionsFor } from './src/platform/lib/collection.js';
import { ensureReplicaSet } from './src/platform/lib/replica-set.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await MongoMemoryServer.create({ instance: { replSet: 'rs0' } });
  const uri = server.getUri();
  const client = new MongoClient(uri, clientOptionsFor(uri));
  await client.connect();
  await ensureReplicaSet(client);
  await client.close();
  project.provide('mongoUri', uri);
  return async () => {
    await server.stop();
  };
}
