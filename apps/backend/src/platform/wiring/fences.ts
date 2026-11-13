import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mongoClientFor } from '../lib/collection.js';
import { theFence } from '../lib/fence.js';
import type { MongoTarget } from '../lib/mongo-target.js';
import { MongoPlatformStore, type PlatformStore } from '../store.js';
import { FenceWatch } from '../services/FenceWatch.js';

export type FencedProcess = 'backend' | 'worker-host' | 'worker-cluster' | 'worker-engine';

const processId = (name: FencedProcess): string => `${name}-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

export async function holdFences(name: FencedProcess, store: PlatformStore): Promise<FenceWatch> {
  const watch = new FenceWatch({ store, fence: theFence(), process: { id: processId(name), name } });
  await watch.start();
  return watch;
}

export function holdFencesIn(name: FencedProcess, mongo: MongoTarget): Promise<FenceWatch> {
  const client = mongoClientFor(mongo.uri);
  return holdFences(name, new MongoPlatformStore(() => client.db(mongo.dbName)));
}
