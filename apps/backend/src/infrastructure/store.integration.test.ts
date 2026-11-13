import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { loadKey } from '../platform/lib/keys.js';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import type { DeploymentMetadata } from '../platform/lib/types.js';
import { MongoInfrastructureStore } from './store.js';
import { infrastructureStoreContract } from './testing/store-contract.js';

const fresh = await emptiedEachTime();

infrastructureStoreContract(async () => (await fresh()).infrastructure);

const key = loadKey({ DATA_KEY: 'k'.repeat(64) }, 'data');

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

  it('seals what a save writes, and what a partial update merges in', async () => {
    await store.saveDeployment(deployment('d2', { nextcloudAdminPassword: 'admin-pw' }));
    expect(looksEncrypted(String((await raw('d2'))?.nextcloudAdminPassword))).toBe(true);

    await store.saveDeploymentInfo({ id: 'd2', searxngSecretKey: 'sx' });
    expect(looksEncrypted(String((await raw('d2'))?.searxngSecretKey))).toBe(true);
    expect((await store.getDeployments()).find((d) => d.id === 'd2')).toMatchObject({ nextcloudAdminPassword: 'admin-pw', searxngSecretKey: 'sx' });
  });

  it('keeps a model server\'s Hugging Face token nowhere in the record but sealed', async () => {
    await store.saveDeployment(deployment('d3', { appType: 'vllm', vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct', vllmGpuCount: 1, vllmHfToken: 'hf_plain_token' }));
    await store.saveDeployment(deployment('d4', { appType: 'tabbyapi', tabbyModel: 'turboderp/Qwen3-exl3', tabbyGpuCount: 1, tabbyHfToken: 'hf_plain_token' }));

    for (const id of ['d3', 'd4']) expect(JSON.stringify(await raw(id))).not.toContain('hf_plain_token');
    expect((await store.getDeployments()).filter((d) => d.id === 'd3' || d.id === 'd4').map((d) => d.vllmHfToken ?? d.tabbyHfToken)).toEqual(['hf_plain_token', 'hf_plain_token']);
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
