import http from 'node:http';
import { Readable } from 'node:stream';
import { Client } from 'minio';
import type { ClusterMetadata, DeploymentMetadata } from '../lib/types.js';
import { FILES_BUCKET, NEXTCLOUD_HOST, NEXTCLOUD_ROOT, NEXTCLOUD_USER, within, type FileEntry, type FilePlace } from '../lib/file-places.js';
import { s3Address, type ServiceSpec } from '../lib/artifacts.js';

export interface Download {
  stream: Readable;
  size?: number | undefined;
  contentType: string;
}

export interface FileStore {
  list(dir: string): Promise<FileEntry[]>;
  download(path: string): Promise<Download | undefined>;
  upload(path: string, body: Readable, size: number | undefined, contentType: string): Promise<void>;
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

export function webAddress(service: ServiceSpec, nodeIp: string | undefined): { host: string; port: number } | undefined {
  const port = service.spec?.ports?.find((entry) => entry.name === 'http') ?? service.spec?.ports?.find((entry) => entry.port === 80);
  if (!port) return undefined;
  if (nodeIp && port.nodePort) return { host: nodeIp, port: port.nodePort };
  const ingress = service.status?.loadBalancer?.ingress?.[0];
  const host = ingress?.ip ?? ingress?.hostname;
  return host ? { host, port: port.port } : undefined;
}

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
    const nodeIp = await this.reach.nodeIp(cluster);
    if (place.kind === 'minio') {
      const address = s3Address(await this.reach.service(cluster, namespaceOf(deployment.name), 'minio'), nodeIp);
      if (!address || !deployment.minioRootPassword) throw new FileServerUnreachableError(`${deployment.name} cannot be reached from Koala.`);
      const client = new Client({ endPoint: address.host, port: address.port, useSSL: false, accessKey: deployment.minioRootUser || 'koala', secretKey: deployment.minioRootPassword });
      return minioStore(client, place.folder);
    }
    const address = webAddress(await this.reach.service(cluster, namespaceOf(deployment.name), 'nextcloud'), nodeIp);
    if (!address || !deployment.nextcloudAdminPassword) throw new FileServerUnreachableError(`${deployment.name} cannot be reached from Koala.`);
    return nextcloudStore({ ...address, user: NEXTCLOUD_USER, password: deployment.nextcloudAdminPassword }, `${NEXTCLOUD_ROOT}/${place.folder}`);
  }
}

type MinioLike = Pick<Client, 'bucketExists' | 'makeBucket' | 'listObjectsV2' | 'getObject' | 'statObject' | 'putObject' | 'removeObjects' | 'copyObject'>;

const collect = <T>(stream: NodeJS.ReadableStream): Promise<T[]> => new Promise((resolve, reject) => {
  const items: T[] = [];
  stream.on('data', (item: T) => items.push(item));
  stream.on('error', reject);
  stream.on('end', () => resolve(items));
});

export function minioStore(client: MinioLike, folder: string): FileStore {
  let ready: Promise<void> | undefined;
  const bucket = () => (ready ??= client.bucketExists(FILES_BUCKET).then(async (exists) => { if (!exists) await client.makeBucket(FILES_BUCKET); }));
  const key = (path: string) => within(folder, path);
  const keysUnder = async (path: string): Promise<string[]> => {
    const prefix = `${key(path)}/`;
    const found = await collect<{ name?: string }>(client.listObjectsV2(FILES_BUCKET, prefix, true));
    return found.flatMap((item) => (item.name ? [item.name] : []));
  };
  const exists = async (path: string): Promise<boolean> => client.statObject(FILES_BUCKET, key(path)).then(() => true, () => false);

  return {
    async list(dir) {
      await bucket();
      const prefix = dir ? `${key(dir)}/` : `${folder}/`;
      const items = await collect<{ name?: string; prefix?: string; size?: number; lastModified?: Date }>(client.listObjectsV2(FILES_BUCKET, prefix, false));
      return items.map((item): FileEntry => {
        const full = (item.prefix ?? item.name ?? '').replace(/\/$/, '');
        const path = full.slice(folder.length + 1);
        return item.prefix
          ? { name: path.split('/').pop() ?? path, path, type: 'dir' }
          : { name: path.split('/').pop() ?? path, path, type: 'file', size: item.size, modified: item.lastModified?.toISOString() };
      }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    },
    async download(path) {
      await bucket();
      const stat = await client.statObject(FILES_BUCKET, key(path)).catch(() => undefined);
      if (!stat) return undefined;
      const stream = await client.getObject(FILES_BUCKET, key(path));
      return { stream: stream as Readable, size: stat.size, contentType: String(stat.metaData?.['content-type'] ?? 'application/octet-stream') };
    },
    async upload(path, body, size, contentType) {
      await bucket();
      await client.putObject(FILES_BUCKET, key(path), body, size, { 'Content-Type': contentType });
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
      const keys = (await collect<{ name?: string }>(client.listObjectsV2(FILES_BUCKET, `${folder}/`, true))).flatMap((item) => (item.name ? [item.name] : []));
      if (keys.length) await client.removeObjects(FILES_BUCKET, keys);
    },
  };
}

export interface Dav {
  host: string;
  port: number;
  user: string;
  password: string;
}

interface DavAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

export function davRequest(dav: Dav, method: string, path: string, options: { headers?: Record<string, string>; body?: Readable | string } = {}): Promise<DavAnswer> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: dav.host,
      port: dav.port,
      method,
      path: `/remote.php/dav/files/${encodeURIComponent(dav.user)}/${encodePath(path)}`,
      headers: {
        Host: NEXTCLOUD_HOST,
        Authorization: `Basic ${Buffer.from(`${dav.user}:${dav.password}`).toString('base64')}`,
        ...options.headers,
      },
    }, (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, stream: response }));
    request.on('error', reject);
    if (options.body instanceof Readable) options.body.pipe(request);
    else request.end(options.body);
  });
}

const drained = async (answer: DavAnswer): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const part of answer.stream) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts).toString('utf8');
};

const davFailed = async (what: string, answer: DavAnswer): Promise<Error> => {
  const text = (await drained(answer)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return new Error(`Nextcloud refused to ${what}: HTTP ${answer.status}${text ? ` ${text}` : ''}`);
};

const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>';

export function readPropfind(xml: string, base: string): FileEntry[] {
  const entries: FileEntry[] = [];
  for (const response of xml.split(/<d:response>/).slice(1)) {
    const href = decodeURIComponent(/<d:href>([^<]*)<\/d:href>/.exec(response)?.[1] ?? '');
    const at = href.indexOf(`/${base}/`);
    const relative = at < 0 ? '' : href.slice(at + base.length + 2).replace(/\/$/, '');
    if (!relative) continue;
    const dir = /<d:collection\s*\/>/.test(response);
    const size = /<d:getcontentlength>(\d+)<\/d:getcontentlength>/.exec(response)?.[1];
    const modified = /<d:getlastmodified>([^<]+)<\/d:getlastmodified>/.exec(response)?.[1];
    entries.push({
      name: relative.split('/').pop() ?? relative,
      path: relative,
      type: dir ? 'dir' : 'file',
      ...(!dir && size ? { size: Number(size) } : {}),
      ...(modified ? { modified: new Date(modified).toISOString() } : {}),
    });
  }
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export function nextcloudStore(dav: Dav, root: string, request: typeof davRequest = davRequest): FileStore {
  const at = (path: string) => within(root, path);
  const makeFolders = async (path: string): Promise<void> => {
    const parts = at(path).split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const answer = await request(dav, 'MKCOL', parts.slice(0, depth).join('/'));
      await drained(answer);
      if (answer.status !== 201 && answer.status !== 405) throw new Error(`Nextcloud refused to make the folder ${parts.slice(0, depth).join('/')}: HTTP ${answer.status}`);
    }
  };

  return {
    async list(dir) {
      const answer = await request(dav, 'PROPFIND', at(dir), { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROPFIND_BODY });
      if (answer.status === 404) { await drained(answer); return []; }
      if (answer.status !== 207) throw await davFailed(`list ${dir || 'the files'}`, answer);
      return readPropfind(await drained(answer), root).filter((entry) => entry.path !== dir);
    },
    async download(path) {
      const answer = await request(dav, 'GET', at(path));
      if (answer.status === 404) { await drained(answer); return undefined; }
      if (answer.status !== 200) throw await davFailed(`read ${path}`, answer);
      const length = answer.headers['content-length'];
      return { stream: answer.stream, ...(length ? { size: Number(length) } : {}), contentType: String(answer.headers['content-type'] ?? 'application/octet-stream') };
    },
    async upload(path, body, size, contentType) {
      await makeFolders(path);
      const answer = await request(dav, 'PUT', at(path), { headers: { 'Content-Type': contentType, ...(size !== undefined ? { 'Content-Length': String(size) } : {}) }, body });
      if (answer.status !== 201 && answer.status !== 204) throw await davFailed(`store ${path}`, answer);
      await drained(answer);
    },
    async remove(path) {
      const answer = await request(dav, 'DELETE', at(path));
      if (answer.status !== 204 && answer.status !== 404) throw await davFailed(`remove ${path}`, answer);
      await drained(answer);
    },
    async move(from, to) {
      await makeFolders(to);
      const destination = `http://${NEXTCLOUD_HOST}/remote.php/dav/files/${encodeURIComponent(dav.user)}/${encodePath(at(to))}`;
      const answer = await request(dav, 'MOVE', at(from), { headers: { Destination: destination, Overwrite: 'F' } });
      if (answer.status !== 201 && answer.status !== 204) throw await davFailed(`move ${from} to ${to}`, answer);
      await drained(answer);
    },
    async removeAll() {
      const answer = await request(dav, 'DELETE', root);
      if (answer.status !== 204 && answer.status !== 404) throw await davFailed(`remove ${root}`, answer);
      await drained(answer);
    },
  };
}
