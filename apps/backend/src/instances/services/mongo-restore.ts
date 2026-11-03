import readline from 'node:readline';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { MongoClient } from 'mongodb';
import { importLines } from '../lib/mongo-move.js';

export async function restoreMongo(client: Pick<MongoClient, 'db'>, dbName: string, gzipped: Readable): Promise<number> {
  return importLines(readline.createInterface({ input: gzipped.pipe(zlib.createGunzip()), crlfDelay: Infinity }), client.db(dbName));
}
