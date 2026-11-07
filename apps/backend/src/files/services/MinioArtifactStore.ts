import type { Client } from 'minio';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf, type ClusterAccess } from '../../infrastructure/index.js';
import { minioEndpoint, type ServiceSpec } from '../lib/artifacts.js';

export interface MinioReach {
  deployments: () => Promise<DeploymentMetadata[]>;
  endpoint: (deployment: DeploymentMetadata) => Promise<{ host: string; port: number }>;
  connect?: ((endpoint: { host: string; port: number; accessKey: string; secretKey: string }) => MinioClient) | undefined;
}

export type MinioClient = Pick<Client, 'bucketExists' | 'makeBucket' | 'putObject' | 'getObject' | 'removeObject'>;

export interface ClusterReachDeps {
  deployments: () => Promise<DeploymentMetadata[]>;
  access: Pick<ClusterAccess, 'reach' | 'kubectl'>;
  clusterById: (id: string) => Promise<ClusterMetadata | undefined>;
}

export function minioReachFrom(deps: ClusterReachDeps): MinioReach {
  return {
    deployments: deps.deployments,
    endpoint: async (deployment) => {
      const namespace = namespaceOf(deployment);
      const reach = await deps.access.reach(deployment.clusterId);
      if (reach.kind === 'root') throw new Error(`${deployment.clusterId} is root's own cluster, which runs no one's MinIO`);
      const service = JSON.parse(await deps.access.kubectl(reach, ['get', 'svc', 'minio', '-n', namespace, '-o', 'json'])) as ServiceSpec;
      if (reach.kind === 'koala') return minioEndpoint(service, namespace, { kind: 'koala' });
      return minioEndpoint(service, namespace, { kind: 'machine', clusterId: reach.clusterId, meshIp: (await deps.clusterById(reach.clusterId))?.meshIp });
    },
  };
}
