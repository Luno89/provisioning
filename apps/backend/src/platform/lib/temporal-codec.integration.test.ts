import { describe, it, expect } from 'vitest';
import type { Payload } from '@temporalio/common';
import { EncryptionCodec, buildDataConverter } from './temporal-codec.js';
import { CompressionCodec, OFFLOAD_ABOVE_BYTES } from './payload-storage.js';
import { testPayloadBlobs } from './test-database.js';

const KEY = 'test-master-key-for-codec';
const te = new TextEncoder();
const td = new TextDecoder();

const only = async (payloads: Promise<Payload[]>): Promise<Payload> => {
  const [payload] = await payloads;
  if (!payload) throw new Error('the codec gave back no payload');
  return payload;
};
const text = (bytes: Uint8Array | null | undefined): string => td.decode(bytes ?? undefined);
const encodingOf = (payload: Payload): string => text(payload.metadata?.encoding);

const plainPayload = (value: unknown): Payload => ({
  metadata: { encoding: te.encode('json/plain') },
  data: te.encode(JSON.stringify(value)),
});

describe('EncryptionCodec', () => {
  const codec = new EncryptionCodec(KEY);

  it('round-trips a payload', async () => {
    const original = plainPayload({ hcloudToken: 'super-secret', name: 'my-cluster' });
    const encoded = await only(codec.encode([original]));
    const decoded = await only(codec.decode([encoded]));

    expect(text(decoded.data)).toBe(text(original.data));
    expect(encodingOf(decoded)).toBe('json/plain');
  });

  it('leaves no plaintext in the encoded payload', async () => {
    const encoded = await only(codec.encode([plainPayload({ hcloudToken: 'super-secret-token' })]));
    const wire = text(encoded.data);
    expect(wire).not.toContain('super-secret-token');
    expect(wire).not.toContain('hcloudToken');
    expect(encodingOf(encoded)).toBe('binary/encrypted-aes-256-gcm');
  });

  it('refuses a payload it did not seal, so nobody can hand a worker plaintext through Temporal', async () => {
    await expect(codec.decode([plainPayload({ ordinary: true })])).rejects.toThrow(/arrived unencrypted \(json\/plain\)/);
    await expect(codec.decode([{ metadata: {}, data: te.encode('{}') }])).rejects.toThrow(/arrived unencrypted \(no encoding\)/);
    await expect(codec.decode([{ metadata: { encoding: te.encode('binary/encrypted-aes-256-gcm') } }])).rejects.toThrow(/arrived unencrypted/);
  });

  it('handles an empty payload list', async () => {
    expect(await codec.encode([])).toEqual([]);
    expect(await codec.decode([])).toEqual([]);
  });

  it('handles a payload with no data', async () => {
    const original: Payload = { metadata: { encoding: te.encode('binary/null') } };
    const encoded = await only(codec.encode([original]));
    const decoded = await only(codec.decode([encoded]));
    expect(encodingOf(decoded)).toBe('binary/null');
    expect(decoded.data).toBeUndefined();
  });

  it('fails loudly on a wrong key rather than returning garbage', async () => {
    const encoded = await only(codec.encode([plainPayload({ a: 1 })]));
    const other = new EncryptionCodec('a-different-key');
    await expect(other.decode([encoded])).rejects.toThrow(/written with a key this worker does not hold/);
  });

  it('reads history written under the old key while writing everything new under the current one', async () => {
    const old = await only(new EncryptionCodec('the-old-jwt-secret').encode([plainPayload({ a: 1 })]));
    const rotated = new EncryptionCodec({ current: 'the-new-payload-key', previous: ['the-old-jwt-secret'] });

    const decoded = await only(rotated.decode([old]));
    expect(JSON.parse(text(decoded.data))).toEqual({ a: 1 });
    const fresh = await only(rotated.encode([plainPayload({ b: 2 })]));
    await expect(new EncryptionCodec('the-old-jwt-secret').decode([fresh])).rejects.toThrow();
  });

  it('refuses to construct without a key', () => {
    expect(() => new EncryptionCodec('')).toThrow(/requires a master key/);
  });
});

describe('buildDataConverter', () => {
  it('compresses before it encrypts, since encrypted bytes no longer compress', () => {
    const dc = buildDataConverter(KEY);
    expect(dc.payloadCodecs.map((codec) => codec.constructor)).toEqual([CompressionCodec, EncryptionCodec]);
  });

  it('still compresses with no key, and only then leaves payloads unencrypted', () => {
    expect(buildDataConverter(undefined).payloadCodecs.map((codec) => codec.constructor)).toEqual([CompressionCodec]);
    expect(buildDataConverter('').payloadCodecs.map((codec) => codec.constructor)).toEqual([CompressionCodec]);
  });

  it('stores large payloads outside Temporal when given somewhere to keep them', () => {
    expect(buildDataConverter(KEY).externalStorage).toBeUndefined();
    const storage = buildDataConverter(KEY, testPayloadBlobs().blobs).externalStorage;
    expect(storage?.payloadSizeThreshold).toBe(OFFLOAD_ABOVE_BYTES);
    expect(storage?.drivers.map((driver) => driver.name)).toEqual(['blobs']);
  });
});
