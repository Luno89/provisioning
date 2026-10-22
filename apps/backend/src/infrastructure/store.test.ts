import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { loadKeys } from '../platform/lib/keys.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { MongoInfrastructureStore } from './store.js';

const key = loadKeys({ DATA_KEY: 'k'.repeat(64) }).data;

const deployment = (id: string, extra: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({
  id, name: id, clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'bo', appType: 'minio', minioRootUser: 'koala', ...extra,
});

describe('the deployments store keeps secrets sealed at rest', () => {
  let client: MongoClient;
  let db: Db;
  let store: MongoInfrastructureStore;

  beforeAll(async () => {
    client = await MongoClient.connect(inject('mongoUri'));
    db = client.db(`t_${randomUUID().replace(/-/g, '').slice(0, 20)}`);
    store = new MongoInfrastructureStore(() => db, key);
  });

  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });

  const raw = async (id: string) => db.collection('deployments').findOne({ _id: id as never });

  it('writes a password as ciphertext and reads it back plain', async () => {
    await store.saveDeployment(deployment('d1', { minioRootPassword: 'hunter2', qdrantApiKey: 'q-key' }));

    const stored = await raw('d1');
    expect(looksEncrypted(String(stored?.minioRootPassword))).toBe(true);
    expect(looksEncrypted(String(stored?.qdrantApiKey))).toBe(true);
    expect(stored?.minioRootUser).toBe('koala');

    const read = (await store.getDeployments()).find((d) => d.id === 'd1');
    expect(read).toMatchObject({ minioRootPassword: 'hunter2', qdrantApiKey: 'q-key', minioRootUser: 'koala' });
  });

  it('seals what a whole list saves, and what a partial update merges in', async () => {
    const [d1] = await store.getDeployments();
    await store.saveDeploymentList([d1!, deployment('d2', { nextcloudAdminPassword: 'admin-pw' })]);
    expect(looksEncrypted(String((await raw('d2'))?.nextcloudAdminPassword))).toBe(true);
    expect(looksEncrypted(String((await raw('d1'))?.minioRootPassword))).toBe(true);

    await store.saveDeploymentInfo({ id: 'd2', searxngSecretKey: 'sx' });
    expect(looksEncrypted(String((await raw('d2'))?.searxngSecretKey))).toBe(true);
    expect((await store.getDeployments()).find((d) => d.id === 'd2')).toMatchObject({ nextcloudAdminPassword: 'admin-pw', searxngSecretKey: 'sx' });
  });

  it('reads a record stored plain before sealing, and seals it once', async () => {
    await db.collection('deployments').insertOne({ _id: 'old' as never, name: 'old', clusterId: 'c1', strategy: 'helm', status: 'running', minioRootPassword: 'from-before' });

    expect((await store.getDeployments()).find((d) => d.id === 'old')?.minioRootPassword).toBe('from-before');
    expect(await store.sealDeploymentSecrets()).toBe(1);
    expect(looksEncrypted(String((await raw('old'))?.minioRootPassword))).toBe(true);
    expect((await store.getDeployments()).find((d) => d.id === 'old')?.minioRootPassword).toBe('from-before');
    expect(await store.sealDeploymentSecrets()).toBe(0);
  });
});
