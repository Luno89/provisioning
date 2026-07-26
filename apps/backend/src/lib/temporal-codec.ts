/**
 * temporal-codec.ts — AES-256-GCM encryption for every Temporal payload.
 *
 * Why this exists: workflow arguments and results are persisted in Temporal's event history
 * indefinitely, and this platform's activity args carry real secrets — a Hetzner API token
 * (ProvisionClusterArgs.hcloudToken), a VM's SSH private key (both as an argument and back out in
 * the workflow result), and HuggingFace tokens. On top of that the connection is plain gRPC to
 * `host.k3d.internal:7233` with no TLS, so those values also crossed the wire in clear.
 *
 * A PayloadCodec is Temporal's own mechanism for exactly this. Registering one here encrypts
 * every payload transparently, which is strictly better than hand-encrypting individual fields:
 * there is no per-field list to keep in sync, and a future sensitive field is covered the day it
 * is added rather than the day someone remembers.
 *
 * Trade-offs, stated plainly:
 *  - Temporal's Web UI can no longer render payloads. Recovering that needs a codec server, which
 *    is deliberately not run here.
 *  - Both workers now need the master key (JWT_SECRET). The cluster worker already mounts
 *    /var/run/docker.sock, which is root-equivalent on the node, so it was already the
 *    highest-value target in the system — this is a small marginal increase.
 */
import type { PayloadCodec } from '@temporalio/common';
import { encryptValue, decryptValue } from './crypto.js';

/**
 * Marks a payload this codec produced. Anything without it is passed through untouched on decode,
 * which is what lets existing plaintext history stay readable after the codec is switched on — the
 * alternative is every historical workflow becoming undecodable at once.
 */
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
      // The whole payload — metadata included — is encrypted, so the original metadata (which can
      // itself reveal types and encoding) is not left in the clear. Temporal's own sample codecs
      // do the same.
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
      // Pass through anything this codec did not produce: plaintext history written before the
      // codec existed, and payloads from any component not yet running it.
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
        // A wrong or rotated JWT_SECRET lands here. Failing loudly beats handing the caller
        // garbage that surfaces later as an inscrutable deserialization error.
        throw new Error(
          `Failed to decrypt a Temporal payload — JWT_SECRET may have changed since it was written: ${
            (err as Error).message
          }`,
        );
      }
    });
  }
}

/**
 * Shared by the client and both workers so they cannot drift. Returns undefined when no master key
 * is configured, in which case Temporal falls back to its default (plaintext) converter rather
 * than refusing to start — the same posture as the rest of the platform's zero-setup dev path.
 */
export function buildDataConverter(masterKey: string | undefined) {
  if (!masterKey) return undefined;
  return {
    payloadCodecs: [new EncryptionCodec(masterKey)],
  };
}
