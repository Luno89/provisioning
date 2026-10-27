import { blobFromWire, blobIdsFrom, type Keyring, type StoredBlob } from '@koala/engine-core/payloads';

export interface MachineTemporal { address: string; namespace: string }

export type RingAnswer = { ring: Keyring; temporal?: MachineTemporal | undefined } | { error: string };
export type PutAnswer = { ok: true } | { ok: false; error: string };
export type GetAnswer = { found: Record<string, string> } | { error: string };

export interface MachineBlobs {
  putFrom(deviceId: string, blobs: readonly StoredBlob[]): Promise<void>;
  getHanded(deviceId: string, ids: readonly string[]): Promise<Map<string, Uint8Array>>;
}

export interface MachinePayloads {
  ring(): RingAnswer;
  put(deviceId: string, raw: unknown): Promise<PutAnswer>;
  get(deviceId: string, raw: unknown): Promise<GetAnswer>;
}

export function machinePayloads(options: { ring: Keyring | undefined; blobs: MachineBlobs; temporal?: MachineTemporal | undefined }): MachinePayloads {
  return {
    ring: () => (options.ring ? { ring: options.ring, ...(options.temporal ? { temporal: options.temporal } : {}) } : { error: 'this Koala runs no work on machines' }),
    async put(deviceId, raw) {
      const listed = (raw as { blobs?: unknown } | null)?.blobs;
      if (!Array.isArray(listed) || listed.length === 0) return { ok: false, error: 'no payloads were sent' };
      const blobs = listed.map(blobFromWire);
      if (blobs.some((blob) => !blob)) return { ok: false, error: 'a payload was not in the shape Koala stores' };
      try {
        await options.blobs.putFrom(deviceId, blobs as StoredBlob[]);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `the payloads could not be stored: ${(err as Error).message}` };
      }
    },
    async get(deviceId, raw) {
      const ids = blobIdsFrom((raw as { ids?: unknown } | null)?.ids);
      try {
        const found = await options.blobs.getHanded(deviceId, ids);
        return { found: Object.fromEntries([...found].map(([id, data]) => [id, Buffer.from(data).toString('base64')])) };
      } catch (err) {
        return { error: `the payloads could not be read: ${(err as Error).message}` };
      }
    },
  };
}
