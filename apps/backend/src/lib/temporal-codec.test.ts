import { describe, it, expect } from 'vitest';
import { EncryptionCodec, buildDataConverter } from './temporal-codec.js';

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
    // The actual point of the codec: a secret in an activity argument must not be readable in
    // Temporal's event history, which stores exactly these bytes.
    const [encoded] = await codec.encode([plainPayload({ hcloudToken: 'super-secret-token' })]);
    const wire = td.decode(encoded.data);
    expect(wire).not.toContain('super-secret-token');
    expect(wire).not.toContain('hcloudToken');
    expect(td.decode(encoded.metadata.encoding)).toBe('binary/encrypted-aes-256-gcm');
  });

  it('passes through payloads it did not produce', async () => {
    // Load-bearing: existing workflow history is plaintext, and without this every historical
    // workflow becomes undecodable the moment the codec is switched on.
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
    await expect(other.decode([encoded])).rejects.toThrow(/JWT_SECRET may have changed/);
  });

  it('refuses to construct without a key', () => {
    expect(() => new EncryptionCodec('')).toThrow(/requires a master key/);
  });
});

describe('buildDataConverter', () => {
  it('returns a converter carrying the codec when a key is set', () => {
    const dc = buildDataConverter(KEY);
    expect(dc?.payloadCodecs).toHaveLength(1);
  });

  it('returns undefined with no key, so Temporal falls back to plaintext rather than failing', () => {
    expect(buildDataConverter(undefined)).toBeUndefined();
    expect(buildDataConverter('')).toBeUndefined();
  });
});
