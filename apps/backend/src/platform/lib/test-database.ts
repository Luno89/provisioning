import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { inject } from 'vitest';
import { MongoDB, mongoTarget } from './mongo-db.js';
import { loadKey } from './keys.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import type { PayloadBlobs } from './payload-storage.js';
import { clientOptionsFor } from './collection.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export const TEST_DATA_KEY = loadKey({ DATA_KEY: 'test-database-data-key-0123456789abcdef' }, 'data');

const open: MongoDB[] = [];
const readers: Array<{ client: MongoClient; dbName: string }> = [];

export interface StoredPayload { id: string; workflowId?: string | undefined; storedAt: Date; handedTo: string[]; size: number }

export function testPayloadBlobs(): { blobs: PayloadBlobs; stored: () => Promise<StoredPayload[]> } {
  const uri = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const { dbName } = mongoTarget({ MONGO_URI: uri });
  const client = new MongoClient(uri, clientOptionsFor(uri));
  readers.push({ client, dbName });
  return {
    blobs: mongoPayloadBlobs(mongoTarget({ MONGO_URI: uri })),
    stored: async () => {
      await client.connect();
      const docs = await client.db(dbName).collection<{ blobId: string; index: number; workflowId?: string; storedAt: Date; handedTo?: string[]; data: { length(): number } }>('temporal_payload_chunks').find({}).sort({ blobId: 1, index: 1 }).toArray();
      const found = new Map<string, StoredPayload>();
      for (const doc of docs) {
        const seen = found.get(doc.blobId);
        if (seen) seen.size += doc.data.length();
        else found.set(doc.blobId, { id: doc.blobId, workflowId: doc.workflowId, storedAt: doc.storedAt, handedTo: doc.handedTo ?? [], size: doc.data.length() });
      }
      return [...found.values()];
    },
  };
}

export async function testDatabaseAt(): Promise<{ db: MongoDB; uri: string; dbName: string }> {
  const uri = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const db = new MongoDB({ mongo: mongoTarget({ MONGO_URI: uri }), dataKey: TEST_DATA_KEY });
  await db.init();
  open.push(db);
  return { db, uri, dbName: mongoTarget({ MONGO_URI: uri }).dbName };
}

export async function testDatabase(): Promise<MongoDB> {
  return (await testDatabaseAt()).db;
}

export async function closeTestDatabases(): Promise<void> {
  for (const reader of readers.splice(0, readers.length)) {
    await reader.client.connect();
    await reader.client.db(reader.dbName).dropDatabase();
    await reader.client.close();
  }
  const closing = open.splice(0, open.length);
  for (const db of closing) {
    await db.dropDatabase();
    await db.close();
  }
}

export async function emptiedEachTime(): Promise<() => Promise<MongoDB>> {
  const base = inject('mongoUri');
  const dbName = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const db = new MongoDB({ mongo: mongoTarget({ MONGO_URI: `${base}${dbName}` }), dataKey: TEST_DATA_KEY });
  await db.init();
  open.push(db);
  const client = new MongoClient(base, clientOptionsFor(base));
  readers.push({ client, dbName });
  return async () => {
    await client.connect();
    const collections = await client.db(dbName).collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    return db;
  };
}
