import type { Database } from '../lib/db-interface.js';
import type { InfrastructureService } from './InfrastructureService.js';
import type { ClusterService } from './ClusterService.js';
import { hasCloudCredentials } from '../lib/credential-resolver.js';
import { isMockCloudProvider } from '../lib/cluster-topology.js';
import { ArtifactService } from './ArtifactService.js';
import { MinioArtifactStores, minioReachFrom } from './MinioArtifactStore.js';

export function createArtifactService(db: Database, infra: InfrastructureService, clusters: ClusterService): { artifacts: ArtifactService; minio: MinioArtifactStores } {
  const minio = new MinioArtifactStores(minioReachFrom({
    db,
    systemCluster: () => clusters.getSystemClusterEntry(),
    kubeconfigOf: (cluster) => clusters.getKubeconfigPath(cluster),
    kubectl: (args, kubeconfig) => infra.runKubectl(args, kubeconfig),
    hostGatewayIp: () => infra.getHostGatewayIp(),
    k3dServerIp: (name) => infra.getK3dServerIp(name),
    isMockCloud: (cluster) => isMockCloudProvider(cluster.provider, hasCloudCredentials),
  }));
  return { artifacts: new ArtifactService({ records: db, minioFor: (ownerId) => minio.storeFor(ownerId) }), minio };
}
