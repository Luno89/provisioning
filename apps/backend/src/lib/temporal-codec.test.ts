import { describe, it, expect } from 'vitest';
import { EncryptionCodec, buildDataConverter } from './temporal-codec.js';
import { CompressionCodec, OFFLOAD_ABOVE_BYTES, inMemoryPayloadBlobs } from './payload-storage.js';

const KEY = 'test-master-key-for-codec';
const te = new TextEncoder();
const td = new TextDecoder();

const plainPayload = (value: unknown) => ({
  metadata: { encoding: te.encode('json/plain') },
  data: te.encode(JSON.stringify(value)),
});

describe('EncryptionCodec', () => {
  const codec = new EncryptionCodec(KEY);

  it('round-trips a payload', async () => {
    const original = plainPayload({ hcloudToken: 'super-secret', name: 'my-cluster' });
    const [encoded] = await codec.encode([original]);
    const [decoded] = await codec.decode([encoded]);

    expect(td.decode(decoded.data)).toBe(td.decode(original.data));
    expect(td.decode(decoded.metadata.encoding)).toBe('json/plain');
  });

  it('leaves no plaintext in the encoded payload', async () => {
    const [encoded] = await codec.encode([plainPayload({ hcloudToken: 'super-secret-token' })]);
    const wire = td.decode(encoded.data);
    expect(wire).not.toContain('super-secret-token');
    expect(wire).not.toContain('hcloudToken');
    expect(td.decode(encoded.metadata.encoding)).toBe('binary/encrypted-aes-256-gcm');
  });

  it('passes through payloads it did not produce', async () => {
    const original = plainPayload({ ordinary: true });
    const [decoded] = await codec.decode([original]);
    expect(decoded).toBe(original);
  });

  it('handles an empty payload list', async () => {
    expect(await codec.encode([])).toEqual([]);
    expect(await codec.decode([])).toEqual([]);
  });

  it('handles a payload with no data', async () => {
    const original = { metadata: { encoding: te.encode('binary/null') }, data: undefined };
    const [encoded] = await codec.encode([original as any]);
    const [decoded] = await codec.decode([encoded]);
    expect(td.decode(decoded.metadata.encoding)).toBe('binary/null');
    expect(decoded.data).toBeUndefined();
  });

  it('fails loudly on a wrong key rather than returning garbage', async () => {
    const [encoded] = await codec.encode([plainPayload({ a: 1 })]);
    const other = new EncryptionCodec('a-different-key');
    await expect(other.decode([encoded])).rejects.toThrow(/written with a key this worker does not hold/);
  });

  it('reads history written under the old key while writing everything new under the current one', async () => {
    const [old] = await new EncryptionCodec('the-old-jwt-secret').encode([plainPayload({ a: 1 })]);
    const rotated = new EncryptionCodec({ current: 'the-new-payload-key', previous: ['the-old-jwt-secret'] });

    const [decoded] = await rotated.decode([old]);
    expect(JSON.parse(td.decode(decoded.data))).toEqual({ a: 1 });
    const [fresh] = await rotated.encode([plainPayload({ b: 2 })]);
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
    const storage = buildDataConverter(KEY, inMemoryPayloadBlobs()).externalStorage;
    expect(storage?.payloadSizeThreshold).toBe(OFFLOAD_ABOVE_BYTES);
    expect(storage?.drivers.map((driver) => driver.name)).toEqual(['blobs']);
  });
});
