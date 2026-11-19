import readline from 'node:readline';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { MongoClient } from 'mongodb';
import { movedRecordsIn } from '../store.js';

export async function restoreMongo(client: Pick<MongoClient, 'db'>, dbName: string, gzipped: Readable): Promise<number> {
  return movedRecordsIn(client.db(dbName)).restore(readline.createInterface({ input: gzipped.pipe(zlib.createGunzip()), crlfDelay: Infinity }));
}
