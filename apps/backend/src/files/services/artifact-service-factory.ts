import type { Database } from '../../platform/lib/db-interface.js';
import type { InfrastructureService } from '../../infrastructure/services/InfrastructureService.js';
import type { ClusterService } from '../../infrastructure/services/ClusterService.js';
import { hasCloudCredentials } from '../../infrastructure/lib/credential-resolver.js';
import { isMockCloudProvider } from '../../infrastructure/lib/cluster-topology.js';
import { ArtifactService } from './ArtifactService.js';
import { MinioArtifactStores, minioReachFrom, type MinioReach } from './MinioArtifactStore.js';

export function createArtifactService(db: Database, infra: InfrastructureService, clusters: ClusterService): { artifacts: ArtifactService; minio: MinioArtifactStores; reach: MinioReach } {
  const reach = minioReachFrom({
    db: db.infrastructure,
    systemCluster: () => clusters.getSystemClusterEntry(),
    kubeconfigOf: (cluster) => clusters.getKubeconfigPath(cluster),
    kubectl: (args, kubeconfig) => infra.runKubectl(args, kubeconfig),
    hostGatewayIp: () => infra.getHostGatewayIp(),
    k3dServerIp: (name) => infra.getK3dServerIp(name),
    isMockCloud: (cluster) => isMockCloudProvider(cluster.provider, hasCloudCredentials),
  });
  const minio = new MinioArtifactStores(reach);
  return { artifacts: new ArtifactService({ records: db.files, minioFor: (ownerId) => minio.storeFor(ownerId) }), minio, reach };
}
