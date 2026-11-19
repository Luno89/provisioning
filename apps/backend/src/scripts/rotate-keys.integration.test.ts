import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, inject } from 'vitest';
import { decryptValue, encryptValue } from '../platform/lib/crypto.js';
import { leaseMongo } from '../platform/lib/mongo-lease.js';
import { resealDatabases } from './rotate-keys.js';

const named = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const untouched = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const ring = { current: 'new-key', previous: ['old-key'] };

afterAll(async () => {
  const lease = await leaseMongo(inject('mongoUri'));
  await lease.client.db(named).dropDatabase();
  await lease.client.db(untouched).dropDatabase();
  await lease.release();
});

describe('npm run keys', () => {
  it('moves every sealed value of the databases it is named onto the current key, and leaves other databases alone', async () => {
    const lease = await leaseMongo(inject('mongoUri'));
    try {
      await lease.client.db(named).collection('users').insertOne({ _id: 'ann' as never, name: 'Ann', credentials: { ovh: { appKey: encryptValue('ovh-secret', 'old-key') } } });
      await lease.client.db(untouched).collection('users').insertOne({ _id: 'bob' as never, credentials: { ovh: { appKey: encryptValue('bob-secret', 'old-key') } } });

      const dry = await resealDatabases(inject('mongoUri'), [named], ring, false);
      expect(dry).toEqual({ counts: [{ at: `${named}.users`, values: 1 }], unreadable: [] });
      const unmoved = await lease.client.db(named).collection<{ credentials: { ovh: { appKey: string } } }>('users').findOne({ _id: 'ann' as never });
      expect(() => decryptValue(unmoved!.credentials.ovh.appKey, 'new-key')).toThrow();

      await resealDatabases(inject('mongoUri'), [named], ring, true);
      const moved = await lease.client.db(named).collection<{ name: string; credentials: { ovh: { appKey: string } } }>('users').findOne({ _id: 'ann' as never });
      expect(moved!.name).toBe('Ann');
      expect(decryptValue(moved!.credentials.ovh.appKey, 'new-key')).toBe('ovh-secret');
      const other = await lease.client.db(untouched).collection<{ credentials: { ovh: { appKey: string } } }>('users').findOne({ _id: 'bob' as never });
      expect(decryptValue(other!.credentials.ovh.appKey, ring)).toBe('bob-secret');
      expect(() => decryptValue(other!.credentials.ovh.appKey, 'new-key')).toThrow();
    } finally {
      await lease.release();
    }
  });
});
