import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { s3StandIn, type S3StandIn } from '../testing/s3-stand-in.js';
import { ArtifactService } from './ArtifactService.js';
import { MinioArtifactStores } from './MinioArtifactStore.js';

let s3: S3StandIn;
beforeAll(async () => { s3 = await s3StandIn(); });
afterAll(async () => { await s3.close(); });

describe('keeping a run\'s artifacts on the person\'s MinIO', () => {
  it('puts each file there through the real S3 client, reads it back whole, and removes it with its run', async () => {
    const db = await testDatabase();
    const minio = { id: 'm1', name: 'files', appType: 'minio', status: 'running', ownerId: 'bo', clusterId: 'c1', minioRootPassword: 'secret-pass' } as DeploymentMetadata;
    const stores = new MinioArtifactStores({
      deployments: async () => [minio],
      clusterById: async () => ({ id: 'c1', name: 'own' }) as ClusterMetadata,
      service: async () => ({ spec: { ports: [{ name: 's3', port: 9000, nodePort: s3.port }] } }),
      nodeIp: async () => '127.0.0.1',
    });
    const artifacts = new ArtifactService({ records: db.files, minioFor: (ownerId) => stores.storeFor(ownerId) });
    const report = Buffer.from('<html>passed</html>');

    const kept = await artifacts.put('bo', 'run-1', [{ name: 'report.html', bytes: report, contentType: 'text/html' }]);
    expect(kept).toMatchObject({ place: 'minio', minioMissing: false, dropped: [] });
    expect([...s3.objects.values()]).toEqual([report]);
    const read = await artifacts.get('bo', kept.stored[0]!.id);
    expect(read?.bytes).toEqual(report);
    expect(await artifacts.removeRun('bo', 'run-1')).toBe(1);
    expect(s3.objects.size).toBe(0);
  });
});
