import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Collection, Db } from 'mongodb';
import { WorkStopped, withWorkFor } from '@koala/engine-core/work-for';
import { Fence } from './fence.js';
import { fencedDb } from './fenced-db.js';

const world = () => {
  const collection = mock<Collection>();
  collection.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'x' } as never);
  collection.updateOne.mockResolvedValue({ acknowledged: true } as never);
  collection.findOneAndUpdate.mockResolvedValue(null);
  collection.deleteMany.mockResolvedValue({ acknowledged: true, deletedCount: 0 });
  collection.findOne.mockResolvedValue({ _id: 'x' } as never);
  const db = mock<Db>();
  db.collection.mockReturnValue(collection);
  const fence = new Fence();
  fence.close({ kind: 'owner', id: 'leaving' });
  return { db: fencedDb(db, fence), collection };
};

describe('every store\'s writes, held at the one database they all go through', () => {
  it('refuses any write made for an account being removed and sends nothing to Mongo', async () => {
    const { db, collection } = world();
    const leaving = (write: () => Promise<unknown>) => withWorkFor({ owner: 'leaving' }, write);
    await expect(leaving(() => db.collection('conversations').insertOne({ _id: 'c1' } as never))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => db.collection('conversations').updateOne({ _id: 'c1' } as never, { $set: { a: 1 } }))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => db.collection('conversations').findOneAndUpdate({ _id: 'c1' } as never, { $set: { a: 1 } }))).rejects.toBeInstanceOf(WorkStopped);
    await expect(leaving(() => db.collection('conversations').deleteMany({}))).rejects.toBeInstanceOf(WorkStopped);
    expect(collection.insertOne).not.toHaveBeenCalled();
    expect(collection.updateOne).not.toHaveBeenCalled();
    expect(collection.findOneAndUpdate).not.toHaveBeenCalled();
    expect(collection.deleteMany).not.toHaveBeenCalled();
  });

  it('still reads for it, and writes for anyone else, as before', async () => {
    const { db, collection } = world();
    await expect(withWorkFor({ owner: 'leaving' }, () => db.collection('conversations').findOne({ _id: 'x' } as never))).resolves.toEqual({ _id: 'x' });
    await withWorkFor({ owner: 'staying' }, () => db.collection('conversations').insertOne({ _id: 'c2' } as never));
    await db.collection('conversations').insertOne({ _id: 'c3' } as never);
    expect(collection.insertOne).toHaveBeenCalledTimes(2);
  });
});
