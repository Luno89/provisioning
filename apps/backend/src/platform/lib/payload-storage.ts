import {
  BlobStorageDriver,
  COMPRESS_ABOVE_BYTES,
  CompressionCodec,
  OFFLOAD_ABOVE_BYTES,
  payloadStorage,
  type BlobReach,
  type StoredBlob,
} from '@koala/engine-core/payloads';

export { BlobStorageDriver, COMPRESS_ABOVE_BYTES, CompressionCodec, OFFLOAD_ABOVE_BYTES, payloadStorage, type StoredBlob };

export const ORPHAN_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface PayloadBlobs extends BlobReach {
  workflowsStoredBefore(cutoff: Date): Promise<string[]>;
  release(workflowId: string): Promise<number>;
  releaseOrphansBefore(cutoff: Date): Promise<number>;
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
