import { Client } from 'minio';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { namespaceOf, type ClusterAccess } from '../../infrastructure/index.js';
import { ARTIFACT_BUCKET, minioEndpoint, minioOf, type ServiceSpec } from '../lib/artifacts.js';
import type { ObjectStore } from './ArtifactService.js';

export interface MinioReach {
  deployments: () => Promise<DeploymentMetadata[]>;
  endpoint: (deployment: DeploymentMetadata) => Promise<{ host: string; port: number }>;
  connect?: ((endpoint: { host: string; port: number; accessKey: string; secretKey: string }) => MinioClient) | undefined;
}

export type MinioClient = Pick<Client, 'bucketExists' | 'makeBucket' | 'putObject' | 'getObject' | 'removeObject'>;

const connectWith = (endpoint: { host: string; port: number; accessKey: string; secretKey: string }): MinioClient =>
  new Client({ endPoint: endpoint.host, port: endpoint.port, useSSL: false, accessKey: endpoint.accessKey, secretKey: endpoint.secretKey });

const read = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
};

export class MinioArtifactStores {
  private readonly ready = new Map<string, { at: number; store: ObjectStore | undefined }>();

  constructor(private readonly reach: MinioReach, private readonly cacheMs = 60_000) {}

  async hasMinio(ownerId: string): Promise<boolean> {
    return Boolean(minioOf(await this.reach.deployments(), ownerId));
  }

  async storeFor(ownerId: string): Promise<ObjectStore | undefined> {
    const cached = this.ready.get(ownerId);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.store;
    const store = await this.open(ownerId);
    this.ready.set(ownerId, { at: Date.now(), store });
    return store;
  }

  private async open(ownerId: string): Promise<ObjectStore | undefined> {
    const deployment = minioOf(await this.reach.deployments(), ownerId);
    if (!deployment) return undefined;
    const address = await this.reach.endpoint(deployment);

    const client = (this.reach.connect ?? connectWith)({
      ...address,
      accessKey: deployment.minioRootUser || 'koala',
      secretKey: deployment.minioRootPassword!,
    });
    if (!(await client.bucketExists(ARTIFACT_BUCKET))) await client.makeBucket(ARTIFACT_BUCKET);

    return {
      put: async (key, bytes, contentType) => { await client.putObject(ARTIFACT_BUCKET, key, bytes, bytes.length, { 'Content-Type': contentType }); },
      get: async (key) => read(await client.getObject(ARTIFACT_BUCKET, key)),
      remove: async (key) => { await client.removeObject(ARTIFACT_BUCKET, key); },
    };
  }
}

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
