import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { ClusterService } from '../../infrastructure/index.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { createArtifactService } from './artifact-service-factory.js';

const cluster = { id: 'c1', name: 'desk', provider: 'machine', meshIp: '100.64.0.7' } as ClusterMetadata;
const minio = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'bo', minioRootPassword: 'pw' } as DeploymentMetadata;

function setUp() {
  const db = memoryDatabase();
  const access = mock<ClusterService['access']>();
  const clusters = mock<Pick<ClusterService, 'access' | 'getByIdUnscoped'>>({ access });
  return { db, access, clusters, made: createArtifactService(db, clusters) };
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

  it('reaches a cluster\'s MinIO through the cluster service\'s access and records', async () => {
    const { access, clusters, made } = setUp();
    access.reach.calledWith('c1').mockResolvedValue({ clusterId: 'c1', kind: 'machine', kubeconfig: 'k' });
    access.kubectl.mockResolvedValue('{"spec":{"ports":[{"name":"s3","port":9000,"nodePort":30900}]}}');
    clusters.getByIdUnscoped.calledWith('c1').mockResolvedValue(cluster);
    expect(await made.reach.endpoint({ ...minio, namespace: 'team-store-m10000' })).toEqual({ host: '100.64.0.7', port: 30900 });
    expect(access.kubectl).toHaveBeenCalledWith({ clusterId: 'c1', kind: 'machine', kubeconfig: 'k' }, ['get', 'svc', 'minio', '-n', 'team-store-m10000', '-o', 'json']);
  });
});
