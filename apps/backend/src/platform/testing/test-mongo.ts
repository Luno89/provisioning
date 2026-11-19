import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MongoBinary } from 'mongodb-memory-server';
import { portToHandOn } from '@koala/engine-core/testing/ports';
import { bytes, freeAt, processProvider, type ProcessProvider, type Provider, type ServiceContext } from '@koala/provision';
import { leaseMongo } from '../lib/mongo-lease.js';

export const TEST_MONGO_CACHE_GB = 0.25;

export interface TestMongo extends Provider<ServiceContext> {
  address(): string;
  uri(): string;
  pid(): number;
  onEnded(listener: (why: string) => void): void;
}

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

export function testMongo(dbPath: string): TestMongo {
  let mongod: ProcessProvider | undefined;
  let port: number | undefined;
  const listeners: Array<(why: string) => void> = [];
  const started = (): ProcessProvider => {
    if (!mongod) throw new Error('the test Mongo is not started');
    return mongod;
  };
  return {
    address: () => `127.0.0.1:${started() && port}`,
    uri: () => `mongodb://127.0.0.1:${started() && port}/`,
    pid: () => started().pid(),
    onEnded(listener) { listeners.push(listener); },
    running: async (ctx) => (mongod ? mongod.running(ctx) : { done: false, why: 'the test Mongo is not started' }),
    async start(ctx, progress) {
      try {
        await mkdir(dbPath, { recursive: true });
        port = await portToHandOn();
        const binary = await MongoBinary.getPath();
        mongod = processProvider({ name: 'mongod', command: binary, args: ['--port', String(port), '--dbpath', dbPath, '--replSet', 'rs0', '--bind_ip', '127.0.0.1', '--unixSocketPrefix', dirname(dbPath), '--wiredTigerCacheSizeGB', String(TEST_MONGO_CACHE_GB)] });
      } catch (err) {
        throw new Error(`the test Mongo could not start: ${err instanceof Error ? err.message : String(err)} ${await disk(dbPath)}`, { cause: err });
      }
      mongod.onEnded((why) => {
        void disk(dbPath).then((where) => { for (const listener of listeners) listener(`the test Mongo ended while the run needed it: ${why} ${where}`); });
      });
      await mongod.start(ctx, progress);
    },
    async ended(ctx, progress) {
      const why = mongod ? await mongod.ended(ctx, progress) : undefined;
      if (!why) return undefined;
      return `the test Mongo could not start: ${why} ${await disk(dbPath)}`;
    },
    async ending(ctx) {
      return `the test Mongo could not start: ${await started().ending!(ctx)} ${await disk(dbPath)}`;
    },
    async remove(ctx, progress) {
      if (mongod) await mongod.remove!(ctx, progress);
      await rm(dbPath, { recursive: true, force: true });
      progress.line(`stopped the test Mongo and removed ${dbPath}`);
    },
  };
}

export async function madePrimary(mongo: TestMongo): Promise<void> {
  const lease = await leaseMongo(mongo.uri());
  await lease.release();
}
