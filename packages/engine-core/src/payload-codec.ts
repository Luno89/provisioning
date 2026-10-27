import crypto from 'node:crypto';
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

const CREDENTIAL_SALT = 'ianthe-credential-encryption-v1';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
export const SEALED_VERSION = 'v2';

export interface Keyring {
  current: string;
  previous?: readonly string[] | undefined;
}

export type SecretKey = string | Keyring;

const derived = new Map<string, Buffer>();

function deriveKey(masterSecret: string): Buffer {
  let key = derived.get(masterSecret);
  if (!key) {
    key = crypto.scryptSync(masterSecret, CREDENTIAL_SALT, KEY_LENGTH);
    derived.set(masterSecret, key);
  }
  return key;
}

export const ringOf = (key: SecretKey): Keyring => (typeof key === 'string' ? { current: key } : key);

export const keyId = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);

export function encryptValue(plaintext: string, key: SecretKey): string {
  const secret = ringOf(key).current;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  return `${SEALED_VERSION}:${keyId(secret)}:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`;
}

function open(secret: string, ivHex: string, authTagHex: string, ciphertext: string): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decryptValue(encrypted: string, key: SecretKey): string {
  const ring = ringOf(key);
  const secrets = [ring.current, ...(ring.previous ?? [])];
  const parts = encrypted.split(':');

  if (parts.length === 5 && parts[0] === SEALED_VERSION) {
    const [, id, ivHex, authTagHex, ciphertext] = parts as [string, string, string, string, string];
    const secret = secrets.find((candidate) => keyId(candidate) === id);
    if (!secret) throw new Error(`this was encrypted with key ${id}, which this platform no longer holds`);
    return open(secret, ivHex, authTagHex, ciphertext);
  }

  if (parts.length !== 3) throw new Error('Invalid encrypted value format');
  const [ivHex, authTagHex, ciphertext] = parts as [string, string, string];
  if (!ivHex || !authTagHex) throw new Error('Invalid encrypted value format');

  let failure: unknown;
  for (const secret of secrets) {
    try {
      return open(secret, ivHex, authTagHex, ciphertext);
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

export const OFFLOAD_ABOVE_BYTES = 128 * 1024;
export const COMPRESS_ABOVE_BYTES = 1024;

const ENCRYPTED = 'binary/encrypted-aes-256-gcm';
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

export class EncryptionCodec implements PayloadCodec {
  constructor(private readonly masterKey: SecretKey) {
    if (!masterKey) throw new Error('EncryptionCodec requires a master key (PAYLOAD_KEY)');
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => ({
      metadata: { encoding: te.encode(ENCRYPTED) },
      data: te.encode(encryptValue(serialize(payload).toString('utf8'), this.masterKey)),
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding;
      if (!encoding || td.decode(encoding) !== ENCRYPTED || !payload.data) {
        throw new Error(`a Temporal payload arrived unencrypted (${encoding ? td.decode(encoding) : 'no encoding'}); Koala reads only payloads its own processes sealed with PAYLOAD_KEY`);
      }
      try {
        return deserialize(Buffer.from(decryptValue(td.decode(payload.data), this.masterKey), 'utf8'));
      } catch (err) {
        throw new Error(
          `Failed to decrypt a Temporal payload — it was written with a key this worker does not hold (PAYLOAD_KEY, or the old JWT_SECRET): ${(err as Error).message}`,
        );
      }
    });
  }
}

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

export interface StoredBlob {
  id: string;
  data: Uint8Array;
  workflowId?: string | undefined;
  storedAt: Date;
}

export interface BlobReach {
  put(blobs: readonly StoredBlob[]): Promise<void>;
  get(ids: readonly string[]): Promise<Map<string, Uint8Array>>;
}

export class BlobStorageDriver implements StorageDriver {
  readonly name = 'blobs';
  readonly type = 'nowrinkles.blobs';

  constructor(private readonly blobs: BlobReach, private readonly now: () => Date = () => new Date()) {}

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    const workflowId = context.target?.kind === 'workflow' ? context.target.id : undefined;
    const storedAt = this.now();
    const blobs = payloads.map((payload) => ({ id: crypto.randomUUID(), data: serialize(payload), workflowId, storedAt }));
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

export function payloadStorage(blobs: BlobReach, threshold = OFFLOAD_ABOVE_BYTES): ExternalStorage {
  return new ExternalStorage({ drivers: [new BlobStorageDriver(blobs)], payloadSizeThreshold: threshold });
}

export function buildDataConverter(masterKey: SecretKey | undefined, blobs?: BlobReach) {
  return {
    payloadCodecs: [new CompressionCodec(), ...(masterKey ? [new EncryptionCodec(masterKey)] : [])],
    ...(blobs ? { externalStorage: payloadStorage(blobs) } : {}),
  };
}

export interface WireBlob {
  id: string;
  data: string;
  workflowId?: string | undefined;
  storedAt: string;
}

export const blobToWire = (blob: StoredBlob): WireBlob => ({
  id: blob.id,
  data: Buffer.from(blob.data).toString('base64'),
  ...(blob.workflowId ? { workflowId: blob.workflowId } : {}),
  storedAt: blob.storedAt.toISOString(),
});

const BLOB_ID = /^[0-9a-f-]{36}$/;

export function blobFromWire(raw: unknown): StoredBlob | undefined {
  const wire = raw as Partial<WireBlob> | null;
  if (!wire || typeof wire.id !== 'string' || !BLOB_ID.test(wire.id) || typeof wire.data !== 'string') return undefined;
  const storedAt = new Date(typeof wire.storedAt === 'string' ? wire.storedAt : Number.NaN);
  return {
    id: wire.id,
    data: Buffer.from(wire.data, 'base64'),
    ...(typeof wire.workflowId === 'string' && wire.workflowId ? { workflowId: wire.workflowId } : {}),
    storedAt: Number.isNaN(storedAt.getTime()) ? new Date() : storedAt,
  };
}

export const blobIdsFrom = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : []).filter((id): id is string => typeof id === 'string' && BLOB_ID.test(id));
