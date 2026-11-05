import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { matches, mock } from 'vitest-mock-extended';
import { MinioArtifactStores, minioReachFrom, type ClusterReachDeps, type MinioClient } from './MinioArtifactStore.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';

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

describe('reaching the MinIO of a cluster', () => {
  const k3d = { id: 'c1', name: 'dev', provider: 'k3d' } as ClusterMetadata;
  const system = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d' } as ClusterMetadata;

  function reachOf(clusters: ClusterMetadata[] = [k3d], deployments: DeploymentMetadata[] = [deployment]) {
    const deps = mock<ClusterReachDeps>();
    deps.db = { getDeployments: async () => deployments, getClusters: async () => clusters };
    deps.systemCluster.mockResolvedValue(system);
    deps.kubeconfigOf.mockImplementation(async (cluster) => `/kube/${cluster.id}`);
    deps.isMockCloud.mockReturnValue(false);
    return { deps, reach: minioReachFrom(deps) };
  }

  it('lists the deployments the database holds', async () => {
    const { reach } = reachOf();
    expect(await reach.deployments()).toEqual([deployment]);
  });

  it('finds a cluster by its id, and the system cluster through the platform rather than the stored ones', async () => {
    const { reach } = reachOf();
    expect(await reach.clusterById('c1')).toBe(k3d);
    expect(await reach.clusterById('missing')).toBeUndefined();
    expect(await reach.clusterById('provisioning-lunorica')).toBe(system);
  });

  it('finds the machine cluster Koala runs on as Koala\'s own cluster, by its own id too', async () => {
    const own = { ...system, id: 'machine-desk', provider: 'machine', machineId: 'desk' } as ClusterMetadata;
    const { isSystem: _system, ...stored } = own;
    const { deps, reach } = reachOf([k3d, stored]);
    deps.systemCluster.mockResolvedValue(own);
    expect(await reach.clusterById('machine-desk')).toBe(own);
    expect(await reach.clusterById('provisioning-lunorica')).toBe(own);
  });

  it('reads a service with kubectl against the cluster\'s own kubeconfig', async () => {
    const { deps, reach } = reachOf();
    deps.kubectl.calledWith(matches<string[]>((args) => args.join(' ') === 'get svc minio -n team-store -o json'), '/kube/c1').mockResolvedValue('{"spec":{"ports":[{"name":"s3","port":9000,"nodePort":30900}]}}');
    expect(await reach.service(k3d, 'team-store', 'minio')).toEqual({ spec: { ports: [{ name: 's3', port: 9000, nodePort: 30900 }] } });
  });

  it('reaches a GPU cluster through the host\'s gateway, a k3d or mocked cloud cluster through its server container, and any other through its mesh address', async () => {
    const { deps, reach } = reachOf();
    deps.hostGatewayIp.mockResolvedValue('172.17.0.1');
    deps.k3dServerIp.calledWith('dev').mockResolvedValue('172.18.0.2');
    deps.k3dServerIp.calledWith('mocked').mockResolvedValue('172.18.0.9');
    expect(await reach.nodeIp({ ...k3d, gpuEnabled: true })).toBe('172.17.0.1');
    expect(await reach.nodeIp(k3d)).toBe('172.18.0.2');
    deps.isMockCloud.mockReturnValue(true);
    expect(await reach.nodeIp({ id: 'c2', name: 'mocked', provider: 'aws' } as ClusterMetadata)).toBe('172.18.0.9');
    deps.isMockCloud.mockReturnValue(false);
    expect(await reach.nodeIp({ id: 'c3', name: 'far', provider: 'hetzner', meshIp: '100.64.0.7' } as ClusterMetadata)).toBe('100.64.0.7');
    expect(await reach.nodeIp({ id: 'c4', name: 'bare', provider: 'hetzner' } as ClusterMetadata)).toBeUndefined();
  });
});
