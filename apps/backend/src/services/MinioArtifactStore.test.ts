import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { MinioArtifactStores, type MinioClient } from './MinioArtifactStore.js';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';

const deployment = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootUser: 'koala', minioRootPassword: 'pw' } as unknown as DeploymentMetadata;
const cluster = { id: 'c1', name: 'dev', provider: 'k3d' } as ClusterMetadata;

const fakeMinio = () => {
  const objects = new Map<string, Buffer>();
  const buckets = new Set<string>();
  const client = {
    bucketExists: async (name: string) => buckets.has(name),
    makeBucket: async (name: string) => { buckets.add(name); },
    putObject: async (_bucket: string, key: string, bytes: Buffer) => { objects.set(key, bytes); return { etag: 'x', versionId: null }; },
    getObject: async (_bucket: string, key: string) => Readable.from([objects.get(key)!]),
    removeObject: async (_bucket: string, key: string) => { objects.delete(key); },
  } as unknown as MinioClient;
  return { objects, buckets, client };
};

describe('the owner\'s MinIO as an artifact store', () => {
  it('reaches it at its service\'s address with its stored keys, and makes the bucket', async () => {
    const minio = fakeMinio();
    const seen: unknown[] = [];
    const stores = new MinioArtifactStores({
      deployments: async () => [deployment],
      clusterById: async () => cluster,
      service: async (_cluster, namespace, name) => { seen.push({ namespace, name }); return { spec: { ports: [{ name: 's3', port: 9000, nodePort: 30900 }] } }; },
      nodeIp: async () => '172.18.0.2',
      connect: (endpoint) => { seen.push(endpoint); return minio.client; },
    });

    const store = (await stores.storeFor('bo'))!;
    await store.put('bo/run/a.png', Buffer.from('png'), 'image/png');

    expect(seen).toEqual([{ namespace: 'team-store', name: 'minio' }, { host: '172.18.0.2', port: 30900, accessKey: 'koala', secretKey: 'pw' }]);
    expect([...minio.buckets]).toEqual(['koala-artifacts']);
    expect((await store.get('bo/run/a.png')).toString()).toBe('png');
  });

  it('has none for someone without a MinIO', async () => {
    const stores = new MinioArtifactStores({ deployments: async () => [deployment], clusterById: async () => cluster, service: async () => ({}), nodeIp: async () => undefined });
    expect(await stores.storeFor('al')).toBeUndefined();
    expect(await stores.hasMinio('al')).toBe(false);
  });
});
