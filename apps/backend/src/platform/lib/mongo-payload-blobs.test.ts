import { describe, expect, it, vi } from 'vitest';

const asked = vi.hoisted(() => ({ uris: [] as string[], databases: [] as string[] }));

vi.mock('./mongo-lease.js', () => ({
  leaseMongo: async (uri: string) => {
    asked.uris.push(uri);
    return {
      client: {
        db: (name: string) => {
          asked.databases.push(name);
          return { collection: () => ({ createIndex: async () => 'made', insertMany: async () => ({}) }) };
        },
      },
      release: async () => undefined,
    };
  },
}));

const { mongoPayloadBlobs } = await import('./mongo-payload-blobs.js');

describe('payloads kept outside Temporal', () => {
  it('are kept over the one Mongo connection the process holds, in its own database', async () => {
    const blobs = mongoPayloadBlobs({ uri: 'mongodb://127.0.0.1:27017/koala', dbName: 'koala' });
    await blobs.put([{ id: 'a', data: Buffer.from('x'), storedAt: new Date() }]);
    await blobs.put([{ id: 'b', data: Buffer.from('y'), storedAt: new Date() }]);
    expect(asked).toEqual({ uris: ['mongodb://127.0.0.1:27017/koala'], databases: ['koala'] });
  });
});
