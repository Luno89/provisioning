import type { Db } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptiedEachTime, freshDb } from '../platform/lib/test-database.js';
import { MongoMachinesStore } from './store.js';
import { machinesStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

machinesStoreContract(async () => (await fresh()).machines);

describe('a join\'s record outlives its code once it has reported', () => {
  let db: Db;
  let store: MongoMachinesStore;

  beforeAll(async () => {
    db = await freshDb();
    store = new MongoMachinesStore(() => db);
  });

  it('moves a code made before joins reported onto the new expiry, so it still goes when its hour is up, and drops the old one', async () => {
    const codes = db.collection('machineJoinCodes');
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    await codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await codes.insertOne({ _id: 'old-hash' as never, ownerId: 'bo', expiresAt });
    await store.ensureIndexes();
    await store.ensureIndexes();
    expect(await store.getMachineJoin('old-hash')).toEqual({ hash: 'old-hash', id: 'old-hash', ownerId: 'bo', expiresAt: expiresAt.toISOString(), keptUntil: expiresAt.toISOString() });
    const ttl = (await codes.indexes()).filter((index) => index.expireAfterSeconds !== undefined).map((index) => Object.keys(index.key));
    expect(ttl).toEqual([['keptUntil']]);
  });
});
