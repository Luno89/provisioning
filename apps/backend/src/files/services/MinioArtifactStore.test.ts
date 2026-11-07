import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { mock } from 'vitest-mock-extended';
import { MinioArtifactStores, minioReachFrom, type ClusterReachDeps, type MinioClient } from './MinioArtifactStore.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';

const deployment = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootUser: 'koala', minioRootPassword: 'pw' } as unknown as DeploymentMetadata;

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
  it('reaches it where its reach says, with its stored keys, and makes the bucket', async () => {
    const minio = fakeMinio();
    const seen: unknown[] = [];
    const stores = new MinioArtifactStores({
      deployments: async () => [deployment],
      endpoint: async (dep) => { seen.push(dep.id); return { host: 'minio.team-store-m10000.svc.cluster.local', port: 9000 }; },
      connect: (endpoint) => { seen.push(endpoint); return minio.client; },
    });

    const store = (await stores.storeFor('bo'))!;
    await store.put('bo/run/a.png', Buffer.from('png'), 'image/png');

    expect(seen).toEqual(['m1', { host: 'minio.team-store-m10000.svc.cluster.local', port: 9000, accessKey: 'koala', secretKey: 'pw' }]);
    expect([...minio.buckets]).toEqual(['koala-artifacts']);
    expect((await store.get('bo/run/a.png')).toString()).toBe('png');
  });

  it('has none for someone without a MinIO, and says why when theirs cannot be reached', async () => {
    const stores = new MinioArtifactStores({ deployments: async () => [deployment], endpoint: async () => { throw new Error('c1 is stopped until something runs on it'); } });
    expect(await stores.storeFor('al')).toBeUndefined();
    expect(await stores.hasMinio('al')).toBe(false);
    await expect(stores.storeFor('bo')).rejects.toThrow('c1 is stopped until something runs on it');
  });
});

describe('reaching the MinIO of a cluster', () => {
  const desk = { id: 'machine-desk', name: 'desk', provider: 'machine', meshIp: '100.64.0.7' } as ClusterMetadata;
  const SERVICE = '{"spec":{"ports":[{"name":"console","port":9001,"nodePort":30901},{"name":"s3","port":9000,"nodePort":30900}]}}';

  function reachOf(clusters: ClusterMetadata[] = [desk]) {
    const access = mock<ClusterReachDeps['access']>();
    access.reach.mockImplementation(async (clusterId) => {
      if (clusterId === 'machine-dev1') return { clusterId, kind: 'koala' };
      if (clusterId === 'root') return { clusterId, kind: 'root' };
      if (clusterId.startsWith('machine-')) return { clusterId, kind: 'machine', kubeconfig: 'k' };
      throw new Error(`${clusterId} is stopped until something runs on it`);
    });
    access.kubectl.mockImplementation(async (_target, args) => { if (args.join(' ') === 'get svc minio -n team-store-m10000 -o json') return SERVICE; throw new Error(`no answer for kubectl ${args.join(' ')}`); });
    const reach = minioReachFrom({ deployments: async () => [deployment], access, clusterById: async (id) => clusters.find((c) => c.id === id) });
    return { access, reach };
  }
  const on = (clusterId: string) => ({ ...deployment, clusterId, namespace: 'team-store-m10000' }) as DeploymentMetadata;

  it('lists the deployments the database holds', async () => {
    expect(await reachOf().reach.deployments()).toEqual([deployment]);
  });

  it('reaches MinIO on Koala\'s own cluster by its service name, in the namespace the app was given', async () => {
    expect(await reachOf().reach.endpoint(on('machine-dev1'))).toEqual({ host: 'minio.team-store-m10000.svc.cluster.local', port: 9000 });
  });

  it('reaches MinIO on another of the person\'s machines at its mesh address and S3 node port', async () => {
    expect(await reachOf().reach.endpoint(on('machine-desk'))).toEqual({ host: '100.64.0.7', port: 30900 });
  });

  it('refuses, saying why, a machine with no mesh address, a stopped one, and root\'s own cluster', async () => {
    const { meshIp: _mesh, ...unmeshed } = desk;
    const { reach } = reachOf([unmeshed as ClusterMetadata]);
    await expect(reach.endpoint(on('machine-desk'))).rejects.toThrow('machine-desk has no mesh address, so Koala cannot reach the MinIO on it');
    await expect(reach.endpoint(on('elsewhere'))).rejects.toThrow('elsewhere is stopped until something runs on it');
    await expect(reach.endpoint(on('root'))).rejects.toThrow('root is root\'s own cluster, which runs no one\'s MinIO');
  });
});
