import type { Readable } from 'node:stream';
import { Client } from 'minio';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/index.js';
import { FILES_BUCKET, FOLDER_MARK, SEARCH_LIMIT, isFolderMark, matchesSearch, within, type FileEntry, type FilePlace } from '../lib/file-places.js';
import { s3Address, type ServiceSpec } from '../lib/artifacts.js';

export interface Download {
  stream: Readable;
  size?: number | undefined;
  contentType: string;
  etag?: string | undefined;
}

export interface FileStore {
  list(dir: string): Promise<FileEntry[]>;
  search(query: string): Promise<FileEntry[]>;
  download(path: string): Promise<Download | undefined>;
  upload(path: string, body: Readable, size: number | undefined, contentType: string): Promise<void>;
  makeFolder(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  removeAll(): Promise<void>;
}

export interface FileStoreReach {
  deployments: () => Promise<DeploymentMetadata[]>;
  clusterById: (id: string) => Promise<ClusterMetadata | undefined>;
  service: (cluster: ClusterMetadata, namespace: string, name: string) => Promise<ServiceSpec>;
  nodeIp: (cluster: ClusterMetadata) => Promise<string | undefined>;
}

const namespaceOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

export class FileServerUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileServerUnreachableError';
  }
}

export class FileStores {
  constructor(private readonly reach: FileStoreReach) {}

  async open(ownerId: string, place: FilePlace): Promise<FileStore> {
    const deployment = (await this.reach.deployments()).find((entry) => entry.id === place.deploymentId && entry.ownerId === ownerId);
    if (!deployment || deployment.status !== 'running') throw new FileServerUnreachableError(`The file server ${place.deploymentId} is not running.`);
    const cluster = await this.reach.clusterById(deployment.clusterId);
    if (!cluster) throw new FileServerUnreachableError(`The cluster ${deployment.name} runs on is gone.`);
    const address = s3Address(await this.reach.service(cluster, namespaceOf(deployment.name), 'minio'), await this.reach.nodeIp(cluster));
    if (!address || !deployment.minioRootPassword) throw new FileServerUnreachableError(`${deployment.name} cannot be reached from Koala.`);
    const client = new Client({ endPoint: address.host, port: address.port, useSSL: false, accessKey: deployment.minioRootUser || 'koala', secretKey: deployment.minioRootPassword });
    return minioStore(client, place.folder);
  }
}

type MinioLike = Pick<Client, 'bucketExists' | 'makeBucket' | 'listObjectsV2' | 'getObject' | 'statObject' | 'putObject' | 'removeObjects' | 'copyObject'>;

const collect = <T>(stream: NodeJS.ReadableStream): Promise<T[]> => new Promise((resolve, reject) => {
  const items: T[] = [];
  stream.on('data', (item: T) => items.push(item));
  stream.on('error', reject);
  stream.on('end', () => resolve(items));
});

const byKind = (a: FileEntry, b: FileEntry) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);

export function minioStore(client: MinioLike, folder: string): FileStore {
  let ready: Promise<void> | undefined;
  const bucket = () => (ready ??= client.bucketExists(FILES_BUCKET).then(async (exists) => { if (!exists) await client.makeBucket(FILES_BUCKET); }));
  const key = (path: string) => within(folder, path);
  const relative = (name: string) => name.slice(folder.length + 1);
  const everything = async (prefix: string) => (await collect<{ name?: string; size?: number; lastModified?: Date }>(client.listObjectsV2(FILES_BUCKET, prefix, true))).filter((item) => item.name);
  const keysUnder = async (path: string): Promise<string[]> => (await everything(`${key(path)}/`)).map((item) => item.name!);
  const exists = async (path: string): Promise<boolean> => client.statObject(FILES_BUCKET, key(path)).then(() => true, () => false);

  return {
    async list(dir) {
      await bucket();
      const prefix = `${dir ? key(dir) : folder}/`;
      const items = await collect<{ name?: string; prefix?: string; size?: number; lastModified?: Date }>(client.listObjectsV2(FILES_BUCKET, prefix, false));
      return items
        .filter((item) => !(item.name && isFolderMark(item.name)))
        .map((item): FileEntry => {
          const path = relative((item.prefix ?? item.name ?? '').replace(/\/$/, ''));
          const name = path.split('/').pop() ?? path;
          return item.prefix
            ? { name, path, type: 'dir' }
            : { name, path, type: 'file', size: item.size, modified: item.lastModified?.toISOString() };
        })
        .sort(byKind);
    },
    async search(query) {
      await bucket();
      return (await everything(`${folder}/`))
        .map((item) => ({ ...item, path: relative(item.name!) }))
        .filter((item) => matchesSearch(item.path, query))
        .slice(0, SEARCH_LIMIT)
        .map((item): FileEntry => ({ name: item.path.split('/').pop() ?? item.path, path: item.path, type: 'file', size: item.size, modified: item.lastModified?.toISOString() }));
    },
    async download(path) {
      await bucket();
      const stat = await client.statObject(FILES_BUCKET, key(path)).catch(() => undefined);
      if (!stat) return undefined;
      const stream = await client.getObject(FILES_BUCKET, key(path));
      return { stream: stream as Readable, size: stat.size, contentType: String(stat.metaData?.['content-type'] ?? 'application/octet-stream'), ...(stat.etag ? { etag: stat.etag } : {}) };
    },
    async upload(path, body, size, contentType) {
      await bucket();
      await client.putObject(FILES_BUCKET, key(path), body, size, { 'Content-Type': contentType });
    },
    async makeFolder(path) {
      await bucket();
      await client.putObject(FILES_BUCKET, key(`${path}/${FOLDER_MARK}`), Buffer.alloc(0), 0, { 'Content-Type': 'application/x-directory' });
    },
    async remove(path) {
      await bucket();
      const keys = [...(await exists(path) ? [key(path)] : []), ...(await keysUnder(path))];
      if (keys.length) await client.removeObjects(FILES_BUCKET, keys);
    },
    async move(from, to) {
      await bucket();
      const moves = await exists(from)
        ? [[key(from), key(to)] as const]
        : (await keysUnder(from)).map((name) => [name, `${key(to)}${name.slice(key(from).length)}`] as const);
      for (const [source, target] of moves) await client.copyObject(FILES_BUCKET, target, `/${FILES_BUCKET}/${source}`);
      if (moves.length) await client.removeObjects(FILES_BUCKET, moves.map(([source]) => source));
    },
    async removeAll() {
      await bucket();
      const keys = (await everything(`${folder}/`)).map((item) => item.name!);
      if (keys.length) await client.removeObjects(FILES_BUCKET, keys);
    },
  };
}
