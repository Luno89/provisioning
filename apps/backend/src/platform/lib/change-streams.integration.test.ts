import { describe, expect, it, vi } from 'vitest';
import { testDatabaseAt } from './test-database.js';
import { leaseMongo } from './mongo-lease.js';
import { keepWrittenDocuments, watchNudges, watchWrites } from './change-streams.js';

describe('following writes to a collection on Mongo', () => {
  it('hears a record written after it is ready, and opens again when Mongo refuses the stream', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
      await keepWrittenDocuments(client.db(dbName), ['watched']);
      const collection = client.db(dbName).collection<{ _id: string; status: string }>('watched');
      let heard!: (id: string) => void;
      const written = new Promise<string>((done) => { heard = done; });
      const watching = watchWrites(() => collection, { status: 'deploying' }, (doc) => heard(doc._id), 10);
      await watching.ready;
      await collection.insertOne({ _id: 'shop', status: 'deploying' });
      expect(await written).toBe('shop');
      await watching.close();

      const warned: string[] = [];
      let reopened!: () => void;
      const twice = new Promise<void>((done) => { reopened = done; });
      vi.spyOn(console, 'warn').mockImplementation((line: string) => { warned.push(line); if (warned.length === 2) reopened(); });
      const refused = watchWrites(() => collection, { status: { $notAnOperator: 1 } }, () => undefined, 10);
      await twice;
      await refused.close();
      expect(warned[0]).toMatch(/^\[change-streams\] following watched stopped \(.*\$notAnOperator.*\); opening it again in 0 s$/);
    } finally {
      vi.restoreAllMocks();
      await release();
    }
  });

  it('hears each write as it was written, even when writes come faster than they are delivered', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
      const db = client.db(dbName);
      await keepWrittenDocuments(db, ['raced']);
      const collection = db.collection<{ _id: string; status: string }>('raced');
      const heard: string[] = [];
      let all!: () => void;
      const three = new Promise<void>((done) => { all = done; });
      const watching = watchWrites(() => collection, {}, (doc) => { heard.push(doc.status); if (heard.length === 3) all(); });
      await watching.ready;
      await collection.insertOne({ _id: 'shop', status: 'deploying' });
      await Promise.all([collection.updateOne({ _id: 'shop' }, { $set: { status: 'deployed' } }), collection.updateOne({ _id: 'shop' }, { $set: { status: 'removed' } })]);
      await three;
      await watching.close();
      expect(heard[0]).toBe('deploying');
      expect(new Set(heard.slice(1))).toEqual(new Set(['deployed', 'removed']));
    } finally {
      await release();
    }
  });

  it('refuses to follow the documents of a collection that was not set up to keep them, naming it', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
      expect(() => watchWrites(() => client.db(dbName).collection('unprepared'), {}, () => undefined)).toThrow(/unprepared.*not set up to keep the documents its writes leave/);
    } finally {
      await release();
    }
  });

  it('nudges with the key of what was written, and no document, on a collection that keeps none', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
      const collection = client.db(dbName).collection<{ _id: string; at: number }>('beats');
      let heard!: (key: unknown) => void;
      const nudged = new Promise<unknown>((done) => { heard = done; });
      const watching = watchNudges(() => collection, (key) => heard(key));
      await watching.ready;
      await collection.insertOne({ _id: 'worker-1', at: 1 });
      expect(await nudged).toEqual({ _id: 'worker-1' });
      await watching.close();
    } finally {
      await release();
    }
  });

  it('sets up every collection Koala follows the documents of when the database opens, in every process', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
      const options = async (name: string) => (((await client.db(dbName).listCollections({ name }).toArray())[0] as { options?: unknown } | undefined)?.options ?? {}) as { changeStreamPreAndPostImages?: { enabled: boolean } };
      for (const name of ['deployments', 'provisioning', 'instances', 'fences', 'endedSessions', 'pipelineRuns', 'odooReleases']) {
        expect((await options(name)).changeStreamPreAndPostImages, name).toEqual({ enabled: true });
      }
    } finally {
      await release();
    }
  });
});

