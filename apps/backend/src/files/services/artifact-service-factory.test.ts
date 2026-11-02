import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterService, InfrastructureService } from '../../infrastructure/index.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { createArtifactService } from './artifact-service-factory.js';

const cluster = { id: 'c1', name: 'dev', provider: 'k3d' } as ClusterMetadata;
const minio = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootPassword: 'pw' } as DeploymentMetadata;

function setUp() {
  const db = memoryDatabase();
  const infra = mock<InfrastructureService>();
  const clusters = mock<ClusterService>();
  return { db, infra, clusters, made: createArtifactService(db, infra, clusters) };
}

describe('the artifact service a process is given', () => {
  it('keeps artifacts in the database when the owner has no MinIO', async () => {
    const { db, made } = setUp();
    const kept = await made.artifacts.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect(kept).toMatchObject({ place: 'mongo', minioMissing: true });
    expect(await db.files.getArtifacts('bo', 'run-1')).toHaveLength(1);
    expect(await made.minio.hasMinio('bo')).toBe(false);
  });

  it('knows an owner has a MinIO from the deployments in the database', async () => {
    const { db, made } = setUp();
    await db.infrastructure.saveDeploymentInfo(minio);
    expect(await made.minio.hasMinio('bo')).toBe(true);
    expect(await made.minio.hasMinio('al')).toBe(false);
  });

  it('reaches a cluster\'s MinIO through the infrastructure and cluster services', async () => {
    const { db, infra, clusters, made } = setUp();
    await db.infrastructure.saveClusterInfo(cluster);
    clusters.getKubeconfigPath.calledWith(cluster).mockResolvedValue('/kube/dev');
    clusters.getSystemClusterEntry.mockResolvedValue({ ...cluster, id: 'provisioning-lunorica' });
    infra.runKubectl.mockResolvedValue('{"spec":{"ports":[{"name":"s3","port":9000,"nodePort":30900}]}}');
    infra.getK3dServerIp.calledWith('dev').mockResolvedValue('172.18.0.2');
    expect((await made.reach.clusterById('c1'))?.name).toBe('dev');
    expect((await made.reach.clusterById('provisioning-lunorica'))?.id).toBe('provisioning-lunorica');
    expect(await made.reach.service(cluster, 'team-store', 'minio')).toEqual({ spec: { ports: [{ name: 's3', port: 9000, nodePort: 30900 }] } });
    expect(infra.runKubectl).toHaveBeenCalledWith(['get', 'svc', 'minio', '-n', 'team-store', '-o', 'json'], '/kube/dev');
    expect(await made.reach.nodeIp(cluster)).toBe('172.18.0.2');
    infra.getHostGatewayIp.mockResolvedValue('172.17.0.1');
    expect(await made.reach.nodeIp({ ...cluster, gpuEnabled: true })).toBe('172.17.0.1');
  });
});
