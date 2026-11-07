import { describe, it, expect } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { minioReachFrom, type ClusterReachDeps } from './MinioArtifactStore.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';

const deployment = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootUser: 'koala', minioRootPassword: 'pw' } as unknown as DeploymentMetadata;

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
