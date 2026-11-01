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
  handTo(workflowId: string, deviceId: string): Promise<void>;
  putFrom(deviceId: string, blobs: readonly StoredBlob[]): Promise<void>;
  getHanded(deviceId: string, ids: readonly string[]): Promise<Map<string, Uint8Array>>;
  workflowsStoredBefore(cutoff: Date): Promise<string[]>;
  release(workflowId: string): Promise<number>;
  releaseOrphansBefore(cutoff: Date): Promise<number>;
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
