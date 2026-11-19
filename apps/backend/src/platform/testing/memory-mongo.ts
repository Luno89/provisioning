import type { EventEmitter } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { bytes, freeAt, type Provider, type ServiceContext } from '@koala/provision';
import { mongoClientFor } from '../lib/collection.js';
import { ensureReplicaSet } from '../lib/replica-set.js';

export interface MemoryMongo extends Provider<ServiceContext> {
  address(): string;
  uri(): string;
  pid(): number;
  onEnded(listener: (why: string) => void): void;
}

const LAST_LINES = 5;

async function nearest(path: string): Promise<string> {
  for (let at = path; ; at = dirname(at)) {
    try {
      return `${path}, ${bytes(await freeAt(at))} free`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(at) === at) throw err;
    }
  }
}

const disk = async (dbPath: string): Promise<string> => `(disk where it writes: ${await nearest(dbPath)})`;

export function memoryMongo(dbPath: string): MemoryMongo {
  let server: MongoMemoryServer | undefined;
  let stopping = false;
  let endedWhy: string | undefined;
  const said: string[] = [];
  const listeners: Array<(why: string) => void> = [];
  const running = (): MongoMemoryServer => {
    if (!server) throw new Error('the test Mongo is not started');
    return server;
  };
  const watch = (started: MongoMemoryServer): void => {
    const instance: EventEmitter = started.instanceInfo!.instance;
    instance.on('instanceSTDOUT', (line: string) => { said.push(...String(line).split('\n').filter(Boolean)); said.splice(0, Math.max(0, said.length - LAST_LINES)); });
    instance.on('instanceClosed', (code: number | null, signal: string | null) => {
      if (stopping) return;
      void (async () => {
        endedWhy = `the test Mongo ended while the run needed it: mongod ${signal ? `was killed by ${signal}` : `exited with ${code}`} (last said: ${said.join(' ') || 'nothing'}) ${await disk(dbPath)}`;
        for (const listener of listeners) listener(endedWhy);
      })();
    });
  };
  return {
    address: () => `127.0.0.1:${running().instanceInfo!.port}`,
    uri: () => running().getUri(),
    pid: () => running().instanceInfo!.instance.mongodProcess!.pid!,
    onEnded(listener) { listeners.push(listener); },
    running: async () => (server?.state === 'running' && !endedWhy ? { done: true } : { done: false, why: endedWhy ?? 'the test Mongo is not started' }),
    async start() {
      try {
        await mkdir(dbPath, { recursive: true });
        server = await MongoMemoryServer.create({ instance: { replSet: 'rs0', dbPath } });
      } catch (err) {
        throw new Error(`the test Mongo could not start: ${err instanceof Error ? err.message : String(err)} ${await disk(dbPath)}`, { cause: err });
      }
      watch(server);
      const client = mongoClientFor(server.getUri());
      try {
        await ensureReplicaSet(client);
      } finally {
        await client.close();
      }
    },
    ended: async () => endedWhy,
    async remove(_ctx, progress) {
      stopping = true;
      if (server) await server.stop({ doCleanup: true, force: true });
      await rm(dbPath, { recursive: true, force: true });
      progress.line(`stopped the test Mongo and removed ${dbPath}`);
    },
  };
}
