import type { Database } from '../../platform/index.js';
import type { ClusterService } from '../../infrastructure/index.js';
import { ArtifactService } from './ArtifactService.js';
import { MinioArtifactStores, minioReachFrom, type MinioReach } from './MinioArtifactStore.js';

export function createArtifactService(db: Database, clusters: Pick<ClusterService, 'access' | 'getByIdUnscoped'>): { artifacts: ArtifactService; minio: MinioArtifactStores; reach: MinioReach } {
  const reach = minioReachFrom({
    deployments: () => db.infrastructure.getDeployments(),
    access: clusters.access,
    clusterById: (id) => clusters.getByIdUnscoped(id),
  });
  const minio = new MinioArtifactStores(reach);
  return { artifacts: new ArtifactService({ records: db.files, minioFor: (ownerId) => minio.storeFor(ownerId) }), minio, reach };
}
