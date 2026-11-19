import type { MongoClient } from 'mongodb';
import { mongoClientFor } from './collection.js';
import type { DependencyReporter } from './dependencies.js';
import { reportMongoReach } from './mongo-reach.js';
import { ensureReplicaSet } from './replica-set.js';

export interface MongoLease {
  readonly client: MongoClient;
  release(): Promise<void>;
}

interface Kept {
  client: MongoClient;
  ready: Promise<void>;
  holds: number;
  reporters: Set<DependencyReporter>;
}

const kept = new Map<string, Kept>();

function keep(uri: string): Kept {
  const client = mongoClientFor(uri);
  const entry: Kept = {
    client,
    holds: 0,
    reporters: new Set(),
    ready: (async () => {
      await client.connect();
      await ensureReplicaSet(client);
    })(),
  };
  entry.ready.catch(async () => {
    if (kept.get(uri) === entry) kept.delete(uri);
    await client.close();
  });
  kept.set(uri, entry);
  return entry;
}

export async function leaseMongo(uri: string, reporters: Iterable<DependencyReporter> = []): Promise<MongoLease> {
  const entry = kept.get(uri) ?? keep(uri);
  entry.holds += 1;
  for (const reporter of reporters) {
    if (entry.reporters.has(reporter)) continue;
    entry.reporters.add(reporter);
    reportMongoReach(entry.client, reporter);
  }
  try {
    await entry.ready;
  } catch (err) {
    entry.holds -= 1;
    throw err;
  }
  let held = true;
  return {
    client: entry.client,
    async release() {
      if (!held) throw new Error('this hold on Mongo was already let go of');
      held = false;
      entry.holds -= 1;
      if (entry.holds > 0) return;
      if (kept.get(uri) === entry) kept.delete(uri);
      await entry.client.close();
    },
  };
}
