import { describe, it, expect } from 'vitest';
import { StorageDriverClaim, type Payload } from '@temporalio/common';
import {
  BlobStorageDriver,
  CompressionCodec,
  ORPHAN_AFTER_MS,
  inMemoryPayloadBlobs,
  sweepPayloadBlobs,
} from './payload-storage.js';

const payload = (text: string): Payload => ({
  metadata: { encoding: new TextEncoder().encode('json/plain') },
  data: new TextEncoder().encode(JSON.stringify(text)),
});

const text = (p: Payload) => JSON.parse(new TextDecoder().decode(p.data)) as string;

describe('compressing payloads', () => {
  it('shrinks a large payload and gives back exactly what went in', async () => {
    const codec = new CompressionCodec();
    const big = payload('a page of search results '.repeat(20_000));

    const [encoded] = await codec.encode([big]);
    const [decoded] = await codec.decode([encoded!]);

    expect(encoded!.data!.length).toBeLessThan(big.data!.length / 10);
    expect(text(decoded!)).toBe(text(big));
    expect(new TextDecoder().decode(decoded!.metadata!.encoding)).toBe('json/plain');
  });

  it('leaves small payloads alone, and passes through ones it did not write', async () => {
    const codec = new CompressionCodec();
    const small = payload('hi');
    expect(await codec.encode([small])).toEqual([small]);
    expect(await codec.decode([small])).toEqual([small]);
  });
});

describe('storing payloads outside Temporal', () => {
  it('hands Temporal a claim and gets the same payload back from it, filed under the workflow that wrote it', async () => {
    const blobs = inMemoryPayloadBlobs();
    const driver = new BlobStorageDriver(blobs);
    const big = payload('x'.repeat(300_000));

    const claims = await driver.store({ target: { kind: 'workflow', namespace: 'default', id: 'run-1' } }, [big]);

    expect(JSON.stringify(claims[0]!.claimData).length).toBeLessThan(100);
    expect([...blobs.stored.values()].map((blob) => blob.workflowId)).toEqual(['run-1']);
    const [back] = await driver.retrieve({}, claims);
    expect(text(back!)).toBe(text(big));
  });

  it('says plainly when a stored payload is gone, rather than handing the run something empty', async () => {
    const driver = new BlobStorageDriver(inMemoryPayloadBlobs());
    await expect(driver.retrieve({}, [new StorageDriverClaim({ id: 'nope' })])).rejects.toThrow(/missing \(blob nope\)/);
  });
});

describe('releasing stored payloads', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date('2026-10-10T00:00:00Z');
  const at = (ms: number) => new Date(now.getTime() - ms);

  it('releases a workflow\'s payloads only once Temporal no longer has that workflow at all', async () => {
    const blobs = inMemoryPayloadBlobs();
    await blobs.put([
      { id: 'a', data: new Uint8Array([1]), workflowId: 'gone', storedAt: at(3 * day) },
      { id: 'b', data: new Uint8Array([1]), workflowId: 'still-running', storedAt: at(30 * day) },
      { id: 'c', data: new Uint8Array([1]), workflowId: 'recent', storedAt: at(day / 2) },
    ]);

    const report = await sweepPayloadBlobs(blobs, async (id) => id !== 'gone', { retentionMs: day, now });

    expect(report.released).toEqual(['gone']);
    expect([...blobs.stored.keys()].sort()).toEqual(['b', 'c']);
  });

  it('does not ask Temporal about a workflow whose payloads are younger than its retention', async () => {
    const blobs = inMemoryPayloadBlobs();
    await blobs.put([{ id: 'c', data: new Uint8Array([1]), workflowId: 'recent', storedAt: at(day / 2) }]);
    const asked: string[] = [];

    await sweepPayloadBlobs(blobs, async (id) => { asked.push(id); return false; }, { retentionMs: day, now });

    expect(asked).toEqual([]);
    expect(blobs.stored.size).toBe(1);
  });

  it('releases payloads that belong to no workflow once they are a week old', async () => {
    const blobs = inMemoryPayloadBlobs();
    await blobs.put([
      { id: 'old', data: new Uint8Array([1]), storedAt: at(ORPHAN_AFTER_MS + day) },
      { id: 'new', data: new Uint8Array([1]), storedAt: at(day) },
    ]);

    const report = await sweepPayloadBlobs(blobs, async () => true, { retentionMs: day, now });

    expect(report.orphans).toBe(1);
    expect([...blobs.stored.keys()]).toEqual(['new']);
  });
});
