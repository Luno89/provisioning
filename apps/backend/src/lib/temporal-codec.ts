import type { PayloadCodec } from '@temporalio/common';
import { encryptValue, decryptValue, type SecretKey } from './crypto.js';
import { CompressionCodec, payloadStorage, type PayloadBlobs } from './payload-storage.js';

const ENCODING = 'binary/encrypted-aes-256-gcm';
const METADATA_ENCODING_KEY = 'encoding';

const te = new TextEncoder();
const td = new TextDecoder();

export class EncryptionCodec implements PayloadCodec {
  constructor(private readonly masterKey: SecretKey) {
    if (!masterKey) {
      throw new Error('EncryptionCodec requires a master key (PAYLOAD_KEY)');
    }
  }

  async encode(payloads: any[]): Promise<any[]> {
    return payloads.map((p) => {
      const serialized = JSON.stringify({
        metadata: Object.fromEntries(
          Object.entries(p.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v as Uint8Array).toString('base64')]),
        ),
        data: p.data ? Buffer.from(p.data).toString('base64') : null,
      });
      return {
        metadata: { [METADATA_ENCODING_KEY]: te.encode(ENCODING) },
        data: te.encode(encryptValue(serialized, this.masterKey)),
      };
    });
  }

  async decode(payloads: any[]): Promise<any[]> {
    return payloads.map((p) => {
      const encoding = p.metadata?.[METADATA_ENCODING_KEY];
      if (!encoding || td.decode(encoding) !== ENCODING) return p;

      try {
        const plaintext = decryptValue(td.decode(p.data), this.masterKey);
        const parsed = JSON.parse(plaintext);
        return {
          metadata: Object.fromEntries(
            Object.entries(parsed.metadata ?? {}).map(([k, v]) => [k, Buffer.from(v as string, 'base64')]),
          ),
          data: parsed.data ? Buffer.from(parsed.data, 'base64') : undefined,
        };
      } catch (err) {
        throw new Error(
          `Failed to decrypt a Temporal payload — it was written with a key this worker does not hold (PAYLOAD_KEY, or the old JWT_SECRET): ${
            (err as Error).message
          }`,
        );
      }
    });
  }
}

export function buildDataConverter(masterKey: SecretKey | undefined, blobs?: PayloadBlobs) {
  return {
    payloadCodecs: [new CompressionCodec(), ...(masterKey ? [new EncryptionCodec(masterKey)] : [])],
    ...(blobs ? { externalStorage: payloadStorage(blobs) } : {}),
  };
}
