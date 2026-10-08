import { Client } from 'minio';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { ARTIFACT_BUCKET, minioOf, s3Address, type ServiceSpec } from '../lib/artifacts.js';
import type { ObjectStore } from './ArtifactService.js';

export interface MinioReach {
  deployments: () => Promise<DeploymentMetadata[]>;
  clusterById: (id: string) => Promise<ClusterMetadata | undefined>;
  service: (cluster: ClusterMetadata, namespace: string, name: string) => Promise<ServiceSpec>;
  nodeIp: (cluster: ClusterMetadata) => Promise<string | undefined>;
  connect?: ((endpoint: { host: string; port: number; accessKey: string; secretKey: string }) => MinioClient) | undefined;
}

export type MinioClient = Pick<Client, 'bucketExists' | 'makeBucket' | 'putObject' | 'getObject' | 'removeObject'>;

const namespaceOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

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
    const cluster = await this.reach.clusterById(deployment.clusterId);
    if (!cluster) return undefined;
    const address = s3Address(await this.reach.service(cluster, namespaceOf(deployment.name), 'minio'), await this.reach.nodeIp(cluster));
    if (!address) return undefined;

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
  db: { getDeployments(): Promise<DeploymentMetadata[]>; getClusters(): Promise<ClusterMetadata[]> };
  systemCluster: () => Promise<ClusterMetadata>;
  kubeconfigOf: (cluster: ClusterMetadata) => Promise<string>;
  kubectl: (args: string[], kubeconfig: string) => Promise<string>;
  hostGatewayIp: () => Promise<string>;
  k3dServerIp: (clusterName: string) => Promise<string>;
  isMockCloud: (cluster: ClusterMetadata) => boolean;
}

export function minioReachFrom(deps: ClusterReachDeps): MinioReach {
  return {
    deployments: () => deps.db.getDeployments(),
    clusterById: async (id) => (id === 'provisioning-lunorica' ? deps.systemCluster() : (await deps.db.getClusters()).find((cluster) => cluster.id === id)),
    service: async (cluster, namespace, name) => JSON.parse(await deps.kubectl(['get', 'svc', name, '-n', namespace, '-o', 'json'], await deps.kubeconfigOf(cluster))) as ServiceSpec,
    nodeIp: async (cluster) => {
      if (cluster.gpuEnabled) return deps.hostGatewayIp();
      if (cluster.provider === 'k3d' || deps.isMockCloud(cluster)) return deps.k3dServerIp(cluster.name);
      return cluster.meshIp || undefined;
    },
  };
}
