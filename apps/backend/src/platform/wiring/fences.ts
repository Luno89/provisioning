import { randomUUID } from 'node:crypto';
import { ignore } from '@koala/engine-core/failures';
import { hostname } from 'node:os';
import { theFence } from '../lib/fence.js';
import type { MongoTarget } from '../lib/mongo-target.js';
import { leaseMongo } from '../lib/mongo-lease.js';
import { MongoPlatformStore, type PlatformStore } from '../store.js';
import { FenceWatch } from '../services/FenceWatch.js';

export type FencedProcess = 'backend' | 'worker-host' | 'worker-cluster' | 'worker-engine';

const processId = (name: FencedProcess): string => `${name}-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

export async function holdFences(name: FencedProcess, store: PlatformStore): Promise<FenceWatch> {
  const watch = new FenceWatch({ store, fence: theFence(), process: { id: processId(name), name } });
  await watch.start();
  return watch;
}

export async function holdFencesIn(name: FencedProcess, mongo: MongoTarget): Promise<FenceWatch> {
  const { client } = await leaseMongo(mongo.uri);
  return holdFences(name, new MongoPlatformStore(() => client.db(mongo.dbName)));
}

export const letGoOfFences = (watch: Pick<FenceWatch, 'stop'>): Promise<void> =>
  watch.stop().catch(ignore('a process stopping cleanly could not take itself off the live list; its beats stop now, so it stops counting as live once they lapse'));

export async function runThenLetGo(worker: { run(): Promise<void> }, watch: FenceWatch): Promise<void> {
  await worker.run();
  await letGoOfFences(watch);
}
