import readline from 'node:readline';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { MongoClient } from 'mongodb';
import { clientOptionsFor } from '../../platform/index.js';
import { importLines } from '../lib/mongo-move.js';

export async function restoreMongo(
  target: { uri: string; dbName: string },
  gzipped: Readable,
  waiting: (why: string) => void = () => undefined,
  clientFor: (uri: string) => Pick<MongoClient, 'connect' | 'db' | 'close'> = (uri) => new MongoClient(uri, clientOptionsFor(uri)),
): Promise<number> {
  const client = clientFor(target.uri);
  for (;;) {
    try {
      await client.connect();
      break;
    } catch (err) {
      waiting((err as Error).message);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  try {
    return await importLines(readline.createInterface({ input: gzipped.pipe(zlib.createGunzip()), crlfDelay: Infinity }), client.db(target.dbName));
  } finally {
    await client.close();
  }
}
