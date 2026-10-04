import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ExternalStorage,
  StorageDriverClaim,
  type Payload,
  type PayloadCodec,
  type StorageDriver,
  type StorageDriverRetrieveContext,
  type StorageDriverStoreContext,
} from '@temporalio/common';

export const OFFLOAD_ABOVE_BYTES = 128 * 1024;
export const COMPRESS_ABOVE_BYTES = 1024;
export const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredBlob {
  id: string;
  data: Uint8Array;
  workflowId?: string | undefined;
  storedAt: Date;
}

export interface PayloadBlobs {
  put(blobs: readonly StoredBlob[]): Promise<void>;
  get(ids: readonly string[]): Promise<Map<string, Uint8Array>>;
  workflowsStoredBefore(cutoff: Date): Promise<string[]>;
  release(workflowId: string): Promise<number>;
  releaseOrphansBefore(cutoff: Date): Promise<number>;
}

const COMPRESSED = 'binary/gzip';
const te = new TextEncoder();
const td = new TextDecoder();

const serialize = (payload: Payload): Buffer => Buffer.from(JSON.stringify({
  metadata: Object.fromEntries(Object.entries(payload.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v as Uint8Array).toString('base64')])),
  data: payload.data ? Buffer.from(payload.data).toString('base64') : null,
}));

const deserialize = (bytes: Uint8Array): Payload => {
  const parsed = JSON.parse(td.decode(bytes)) as { metadata: Record<string, string>; data: string | null };
  return {
    metadata: Object.fromEntries(Object.entries(parsed.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64')])),
    ...(parsed.data !== null ? { data: Buffer.from(parsed.data, 'base64') } : {}),
  };
};

export class CompressionCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      if ((payload.data?.length ?? 0) < COMPRESS_ABOVE_BYTES) return payload;
      return { metadata: { encoding: te.encode(COMPRESSED) }, data: gzipSync(serialize(payload)) };
    });
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding;
      if (!encoding || td.decode(encoding) !== COMPRESSED || !payload.data) return payload;
      return deserialize(gunzipSync(payload.data));
    });
  }
}

export class BlobStorageDriver implements StorageDriver {
  readonly name = 'blobs';
  readonly type = 'nowrinkles.blobs';

  constructor(private readonly blobs: PayloadBlobs, private readonly now: () => Date = () => new Date()) {}

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    const workflowId = context.target?.kind === 'workflow' ? context.target.id : undefined;
    const storedAt = this.now();
    const blobs = payloads.map((payload) => ({ id: randomUUID(), data: serialize(payload), workflowId, storedAt }));
    await this.blobs.put(blobs);
    return blobs.map((blob) => new StorageDriverClaim({ id: blob.id }));
  }

  async retrieve(_context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]> {
    const ids = claims.map((claim) => claim.claimData.id ?? '');
    const found = await this.blobs.get(ids);
    return ids.map((id) => {
      const data = found.get(id);
      if (!data) throw new Error(`a Temporal payload stored outside Temporal is missing (blob ${id}); it may have been released early`);
      return deserialize(data);
    });
  }
}

export function payloadStorage(blobs: PayloadBlobs, threshold = OFFLOAD_ABOVE_BYTES): ExternalStorage {
  return new ExternalStorage({ drivers: [new BlobStorageDriver(blobs)], payloadSizeThreshold: threshold });
}

export function inMemoryPayloadBlobs(): PayloadBlobs & { readonly stored: Map<string, StoredBlob> } {
  const stored = new Map<string, StoredBlob>();
  const releaseWhere = (match: (blob: StoredBlob) => boolean): number => {
    let released = 0;
    for (const [id, blob] of stored) {
      if (match(blob)) { stored.delete(id); released += 1; }
    }
    return released;
  };
  return {
    stored,
    async put(blobs) { for (const blob of blobs) stored.set(blob.id, { ...blob, data: Buffer.from(blob.data) }); },
    async get(ids) {
      const found = new Map<string, Uint8Array>();
      for (const id of ids) {
        const blob = stored.get(id);
        if (blob) found.set(id, blob.data);
      }
      return found;
    },
    async workflowsStoredBefore(cutoff) {
      return [...new Set([...stored.values()].filter((blob) => blob.workflowId && blob.storedAt < cutoff).map((blob) => blob.workflowId!))];
    },
    async release(workflowId) { return releaseWhere((blob) => blob.workflowId === workflowId); },
    async releaseOrphansBefore(cutoff) { return releaseWhere((blob) => !blob.workflowId && blob.storedAt < cutoff); },
  };
}

export interface SweepReport {
  released: string[];
  kept: number;
  orphans: number;
}

export async function sweepPayloadBlobs(
  blobs: PayloadBlobs,
  workflowExists: (workflowId: string) => Promise<boolean>,
  options: { retentionMs: number; now?: Date },
): Promise<SweepReport> {
  const now = options.now ?? new Date();
  const candidates = await blobs.workflowsStoredBefore(new Date(now.getTime() - options.retentionMs));
  const released: string[] = [];
  let kept = 0;
  for (const workflowId of candidates) {
    if (await workflowExists(workflowId)) { kept += 1; continue; }
    await blobs.release(workflowId);
    released.push(workflowId);
  }
  const orphans = await blobs.releaseOrphansBefore(new Date(now.getTime() - ORPHAN_AFTER_MS));
  return { released, kept, orphans };
}
