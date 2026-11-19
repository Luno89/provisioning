import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { inject } from 'vitest';
import { MongoDB, mongoTarget } from './mongo-db.js';
import { loadKey } from './keys.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';
import type { PayloadBlobs } from './payload-storage.js';
import { leaseMongo, type MongoLease } from './mongo-lease.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

export const TEST_DATA_KEY = loadKey({ DATA_KEY: 'test-database-data-key-0123456789abcdef' }, 'data');

const open: MongoDB[] = [];
interface Reader { uri: string; dbName: string; lease?: Promise<MongoLease> }
const readers: Reader[] = [];
const reader = (uri: string, dbName: string): Reader => {
  const made: Reader = { uri, dbName };
  readers.push(made);
  return made;
};
const held = (made: Reader): Promise<MongoLease> => {
  made.lease ??= leaseMongo(made.uri);
  return made.lease;
};

export interface StoredPayload { id: string; workflowId?: string | undefined; storedAt: Date; handedTo: string[]; size: number }

export function testPayloadBlobs(): { blobs: PayloadBlobs; stored: () => Promise<StoredPayload[]> } {
  const uri = `${inject('mongoUri')}t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const { dbName } = mongoTarget({ MONGO_URI: uri });
  const stored = reader(uri, dbName);
  return {
    blobs: mongoPayloadBlobs(mongoTarget({ MONGO_URI: uri })),
    stored: async () => {
      const docs = await (await held(stored)).client.db(dbName).collection<{ blobId: string; index: number; workflowId?: string; storedAt: Date; handedTo?: string[]; data: { length(): number } }>('temporal_payload_chunks').find({}).sort({ blobId: 1, index: 1 }).toArray();
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

export async function freshDb(): Promise<Db> {
  const made = reader(inject('mongoUri'), `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  return (await held(made)).client.db(made.dbName);
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
  for (const made of readers.splice(0, readers.length)) {
    const lease = await held(made);
    await lease.client.db(made.dbName).dropDatabase();
    await lease.release();
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
  const emptied = reader(base, dbName);
  return async () => {
    const collections = await (await held(emptied)).client.db(dbName).collections();
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
    return db;
  };
}
