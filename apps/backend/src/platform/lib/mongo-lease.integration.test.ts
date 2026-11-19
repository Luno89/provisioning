import { randomUUID } from 'node:crypto';
import { describe, expect, it, inject } from 'vitest';
import { leaseMongo } from './mongo-lease.js';

const fresh = (): string => `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

describe('the one Mongo connection a process keeps', () => {
  it('is shared by every part of the process that asks for the same Mongo', async () => {
    const uri = inject('mongoUri');
    const first = await leaseMongo(uri);
    const second = await leaseMongo(uri);
    try {
      expect(second.client).toBe(first.client);
    } finally {
      await second.release();
      await first.release();
    }
  });

  it('stays open while any part still holds it, and closes once the last lets go', async () => {
    const uri = inject('mongoUri');
    const name = fresh();
    const first = await leaseMongo(uri);
    const second = await leaseMongo(uri);
    await first.release();
    await second.client.db(name).collection('kept').insertOne({ _id: 'one' as never });
    expect(await second.client.db(name).collection('kept').countDocuments()).toBe(1);
    await second.client.db(name).dropDatabase();
    await second.release();
    const again = await leaseMongo(uri);
    try {
      expect(again.client).not.toBe(second.client);
    } finally {
      await again.release();
    }
  });

  it('writes no field a record leaves undefined, rather than storing it as null', async () => {
    const lease = await leaseMongo(inject('mongoUri'));
    const db = lease.client.db(fresh());
    try {
      await db.collection('records').insertOne({ _id: 'ann' as never, name: 'Ann', removedAt: undefined });
      expect(await db.collection('records').findOne({ _id: 'ann' as never })).toEqual({ _id: 'ann', name: 'Ann' });
    } finally {
      await db.dropDatabase();
      await lease.release();
    }
  });

  it('is a replica set member that has become primary by the time it is handed out', async () => {
    const lease = await leaseMongo(inject('mongoUri'));
    try {
      const hello = await lease.client.db('admin').command({ hello: 1 }) as { isWritablePrimary?: boolean; setName?: string };
      expect(hello.setName).toBeTruthy();
      expect(hello.isWritablePrimary).toBe(true);
    } finally {
      await lease.release();
    }
  });
});
