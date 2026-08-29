import type { PayloadCodec } from '@temporalio/common';
import { encryptValue, decryptValue } from './crypto.js';

const ENCODING = 'binary/encrypted-aes-256-gcm';
const METADATA_ENCODING_KEY = 'encoding';

const te = new TextEncoder();
const td = new TextDecoder();

export class EncryptionCodec implements PayloadCodec {
  constructor(private readonly masterKey: string) {
    if (!masterKey) {
      throw new Error('EncryptionCodec requires a master key (JWT_SECRET)');
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
          `Failed to decrypt a Temporal payload — JWT_SECRET may have changed since it was written: ${
            (err as Error).message
          }`,
        );
      }
    });
  }
}

export function buildDataConverter(masterKey: string | undefined) {
  if (!masterKey) return undefined;
  return {
    payloadCodecs: [new EncryptionCodec(masterKey)],
  };
}
