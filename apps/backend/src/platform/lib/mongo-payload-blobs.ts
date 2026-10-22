import { Binary, MongoClient, type Collection } from 'mongodb';
import { mongoTarget } from './mongo-db.js';
import type { PayloadBlobs, StoredBlob } from './payload-storage.js';

const CHUNK_BYTES = 8 * 1024 * 1024;

interface ChunkDoc {
  _id: string;
  blobId: string;
  index: number;
  workflowId?: string;
  storedAt: Date;
  data: Binary;
}

export function mongoPayloadBlobs(env: Readonly<Record<string, string | undefined>> = process.env): PayloadBlobs {
  let ready: Promise<Collection<ChunkDoc>> | undefined;
  const chunks = (): Promise<Collection<ChunkDoc>> => {
    ready ??= (async () => {
      const { uri, dbName } = mongoTarget(env);
      const client = new MongoClient(uri);
      await client.connect();
      const collection = client.db(dbName).collection<ChunkDoc>('temporal_payload_chunks');
      await collection.createIndex({ blobId: 1, index: 1 });
      await collection.createIndex({ workflowId: 1, storedAt: 1 });
      await collection.createIndex({ storedAt: 1 });
      return collection;
    })().catch((err) => { ready = undefined; throw err; });
    return ready;
  };

  const toChunks = (blob: StoredBlob): ChunkDoc[] => {
    const docs: ChunkDoc[] = [];
    for (let offset = 0, index = 0; offset < blob.data.length || index === 0; offset += CHUNK_BYTES, index += 1) {
      docs.push({
        _id: `${blob.id}:${index}`,
        blobId: blob.id,
        index,
        ...(blob.workflowId ? { workflowId: blob.workflowId } : {}),
        storedAt: blob.storedAt,
        data: new Binary(blob.data.subarray(offset, offset + CHUNK_BYTES)),
      });
    }
    return docs;
  };

  return {
    async put(blobs) {
      const docs = blobs.flatMap(toChunks);
      if (docs.length > 0) await (await chunks()).insertMany(docs, { ordered: false });
    },
    async get(ids) {
      const found = new Map<string, Uint8Array>();
      if (ids.length === 0) return found;
      const docs = await (await chunks()).find({ blobId: { $in: [...ids] } }).sort({ blobId: 1, index: 1 }).toArray();
      const parts = new Map<string, Buffer[]>();
      for (const doc of docs) parts.set(doc.blobId, [...(parts.get(doc.blobId) ?? []), Buffer.from(doc.data.buffer)]);
      for (const [id, buffers] of parts) found.set(id, Buffer.concat(buffers));
      return found;
    },
    async workflowsStoredBefore(cutoff) {
      const ids = await (await chunks()).distinct('workflowId', { workflowId: { $exists: true }, storedAt: { $lt: cutoff } });
      return ids.filter((id): id is string => typeof id === 'string');
    },
    async release(workflowId) {
      return (await (await chunks()).deleteMany({ workflowId })).deletedCount;
    },
    async releaseOrphansBefore(cutoff) {
      return (await (await chunks()).deleteMany({ workflowId: { $exists: false }, storedAt: { $lt: cutoff } })).deletedCount;
    },
  };
}
