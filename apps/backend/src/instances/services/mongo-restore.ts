import readline from 'node:readline';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { MongoClient } from 'mongodb';
import { mongoClientFor, reopening } from '../../platform/index.js';
import { importLines } from '../lib/mongo-move.js';

export async function restoreMongo(
  target: { uri: string; dbName: string },
  gzipped: Readable,
  waiting?: (why: string) => void,
  clientFor: (uri: string) => Pick<MongoClient, 'connect' | 'db' | 'close'> = mongoClientFor,
): Promise<number> {
  const client = clientFor(target.uri);
  const again = reopening(3000);
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      waiting?.((err as Error).message);
    }
    await again.after();
  }
  try {
    return await importLines(readline.createInterface({ input: gzipped.pipe(zlib.createGunzip()), crlfDelay: Infinity }), client.db(target.dbName));
  } finally {
    await client.close();
  }
}
