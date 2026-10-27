import { afterAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { mongoTarget } from './mongo-db.js';
import { mongoPayloadBlobs } from './mongo-payload-blobs.js';

const INPUT = '0b9f3c1e-6a3d-4f7a-9e2b-1c2d3e4f5a6b';
const OTHER = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const RESULT = '2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a';

afterAll(async () => {
  const { uri, dbName } = mongoTarget(process.env);
  const client = await new MongoClient(uri).connect();
  await client.db(dbName).dropDatabase();
  await client.close();
});

describe('payloads stored outside Temporal, on Mongo', () => {
  it('gives a machine only what was stored for a workflow it was handed a task of, and what it stored itself', async () => {
    const blobs = mongoPayloadBlobs(process.env);
    const big = Buffer.alloc(9 * 1024 * 1024, 7);
    await blobs.put([
      { id: INPUT, data: big, workflowId: 'run-1', storedAt: new Date() },
      { id: OTHER, data: Buffer.from('someone else\'s'), workflowId: 'run-2', storedAt: new Date() },
    ]);
    expect((await blobs.getHanded('d1', [INPUT, OTHER])).size).toBe(0);

    await blobs.handTo('run-1', 'd1');
    await blobs.handTo('run-1', 'd1');
    const handed = await blobs.getHanded('d1', [INPUT, OTHER]);
    expect([...handed.keys()]).toEqual([INPUT]);
    expect(Buffer.from(handed.get(INPUT)!).equals(big)).toBe(true);
    expect((await blobs.getHanded('d2', [INPUT, OTHER])).size).toBe(0);

    await blobs.putFrom('d1', [{ id: RESULT, data: Buffer.from('its answer'), workflowId: 'run-1', storedAt: new Date() }]);
    expect([...(await blobs.getHanded('d1', [RESULT])).keys()]).toEqual([RESULT]);
    expect((await blobs.getHanded('d2', [RESULT])).size).toBe(0);
    expect((await blobs.get([INPUT, OTHER, RESULT])).size).toBe(3);

    await expect(blobs.putFrom('d2', [{ id: INPUT, data: Buffer.from('replaced'), workflowId: 'run-1', storedAt: new Date() }])).rejects.toThrow();
    expect(Buffer.from((await blobs.get([INPUT])).get(INPUT)!).equals(big)).toBe(true);
    expect((await blobs.getHanded('d2', [INPUT])).size).toBe(0);

    await expect(blobs.putFrom('d1', [{ id: OTHER, data: big, workflowId: 'run-2', storedAt: new Date() }])).rejects.toThrow();
    expect(Buffer.from((await blobs.get([OTHER])).get(OTHER)!).toString()).toBe('someone else\'s');
    expect((await blobs.getHanded('d1', [OTHER])).size).toBe(0);
  });
});
