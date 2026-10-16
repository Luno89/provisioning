import { describe, it, expect } from 'vitest';
import { blobToWire } from '@koala/engine-core/payloads';
import { machinePayloads } from './machine-payloads.js';
import { inMemoryPayloadBlobs } from './payload-storage.js';

const ID = '0b9f3c1e-6a3d-4f7a-9e2b-1c2d3e4f5a6b';

describe('what a machine is given to read its instance\'s payloads', () => {
  it('hands the payload keyring only where machines run work', () => {
    const ring = { current: 'k'.repeat(64), previous: ['o'.repeat(64)] };
    expect(machinePayloads({ ring, blobs: inMemoryPayloadBlobs() }).ring()).toEqual({ ring });
    expect(machinePayloads({ ring: undefined, blobs: inMemoryPayloadBlobs() }).ring()).toEqual({ error: 'this Koala runs no work on machines' });
  });

  it('stores what a machine offloads and gives it back by id', async () => {
    const blobs = inMemoryPayloadBlobs();
    const payloads = machinePayloads({ ring: undefined, blobs });
    const storedAt = new Date('2026-10-15T10:00:00Z');
    expect(await payloads.put({ blobs: [blobToWire({ id: ID, data: Buffer.from('big result'), workflowId: 'run-1', storedAt })] })).toEqual({ ok: true });
    expect(blobs.stored.get(ID)).toMatchObject({ workflowId: 'run-1', storedAt });
    expect(await payloads.get({ ids: [ID, 'not-an-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] })).toEqual({ found: { [ID]: Buffer.from('big result').toString('base64') } });
  });

  it('refuses payloads in a shape it does not store, storing none of them', async () => {
    const blobs = inMemoryPayloadBlobs();
    const payloads = machinePayloads({ ring: undefined, blobs });
    expect(await payloads.put({ blobs: [blobToWire({ id: ID, data: Buffer.from('x'), storedAt: new Date() }), { id: '../etc', data: 'eA==' }] })).toEqual({ ok: false, error: 'a payload was not in the shape Koala stores' });
    expect(await payloads.put({})).toEqual({ ok: false, error: 'no payloads were sent' });
    expect(blobs.stored.size).toBe(0);
  });
});
