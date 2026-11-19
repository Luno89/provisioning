import crypto, { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { leaseMongo, type MongoLease } from './mongo-lease.js';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { decryptValue, encryptValue } from './crypto.js';
import { reencrypt } from './key-rotation.js';

const unversioned = (plaintext: string, secret: string): string => {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(secret, 'ianthe-credential-encryption-v1', 32), iv);
  const body = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body}`;
};

describe('a secret stored before keys had ids', () => {
  let lease: MongoLease;
  let db: Db;
  const ring = { current: 'new-key', previous: ['old-key'] };

  beforeAll(async () => {
    lease = await leaseMongo(inject('mongoUri'));
    db = lease.client.db(`t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await lease.release();
  });

  it('is refused when read, naming npm run keys, and npm run keys moves it onto the current key', async () => {
    const users = db.collection<{ _id: string; credentials: Record<string, Record<string, string>> }>('users');
    await users.insertOne({ _id: 'ann', credentials: { huggingface: { hfToken: unversioned('hf-secret', 'old-key') }, ovh: { appKey: encryptValue('ovh-secret', 'old-key') } } });
    const stored = (await users.findOne({ _id: 'ann' }))!;
    expect(() => decryptValue(stored.credentials.huggingface!.hfToken!, ring)).toThrow('this was sealed before keys were versioned; run npm run keys');

    for await (const doc of users.find({})) {
      const result = reencrypt(doc, ring);
      expect(result.unreadable).toEqual([]);
      expect(result.rewritten).toEqual(['credentials.huggingface.hfToken', 'credentials.ovh.appKey']);
      await users.replaceOne({ _id: doc._id }, result.value);
    }

    const moved = (await users.findOne({ _id: 'ann' }))!;
    expect(decryptValue(moved.credentials.huggingface!.hfToken!, 'new-key')).toBe('hf-secret');
    expect(decryptValue(moved.credentials.ovh!.appKey!, 'new-key')).toBe('ovh-secret');
  });
});
