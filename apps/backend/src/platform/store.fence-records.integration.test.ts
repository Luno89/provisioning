import { describe, expect, it } from 'vitest';
import { freshDb } from './lib/test-database.js';
import { MongoPlatformStore } from './store.js';
import { fenceRecordsDropped } from './lib/migrations.js';

describe('the records the fence left behind', () => {
  it('drops the fence\'s three collections where they are, says how many records each held, and leaves every other collection alone', async () => {
    const db = await freshDb();
    await db.collection('fences').insertOne({ _id: 'f1' } as never);
    await db.collection('fenceAcks').insertMany([{ _id: 'a1' }, { _id: 'a2' }] as never);
    await db.collection('koalaProcesses').insertOne({ _id: 'p1' } as never);
    await db.collection('migrations').insertOne({ _id: 'kept' } as never);
    const store = new MongoPlatformStore(() => db);

    expect(await store.dropFenceRecords()).toEqual({ fences: 1, fenceAcks: 2, koalaProcesses: 1 });
    const left = (await db.listCollections({}, { nameOnly: true }).toArray()).map((collection) => collection.name);
    expect(left).toEqual(['migrations']);
    expect(await store.dropFenceRecords()).toEqual({ fences: 0, fenceAcks: 0, koalaProcesses: 0 });
  });

  it('are dropped once at start, by name, and never again', async () => {
    const db = await freshDb();
    await db.collection('fences').insertOne({ _id: 'f1' } as never);
    const store = new MongoPlatformStore(() => db);

    expect(await fenceRecordsDropped(store, '2026-11-21T12:00:00.000Z')).toEqual({ fences: 1, fenceAcks: 0, koalaProcesses: 0 });
    await db.collection('fences').insertOne({ _id: 'f2' } as never);
    expect(await fenceRecordsDropped(store, '2026-11-21T13:00:00.000Z')).toEqual({});
    expect(await store.hasMigration('fence-records-dropped')).toBe(true);
  });
});
