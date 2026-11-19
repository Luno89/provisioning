import { describe, expect, it, vi } from 'vitest';
import { testDatabaseAt } from './test-database.js';
import { leaseMongo } from './mongo-lease.js';
import { watchWrites } from './change-streams.js';

describe('following writes to a collection on Mongo', () => {
  it('hears a record written after it is ready, and opens again when Mongo refuses the stream', async () => {
    const { uri, dbName } = await testDatabaseAt();
    const { client, release } = await leaseMongo(uri);
    try {
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
});
