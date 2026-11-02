import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mock } from 'vitest-mock-extended';
import { FileServerUnreachableError, FileStores, minioStore, type FileStoreReach } from './FileStores.js';
import type { ClusterMetadata, DeploymentMetadata } from '../../platform/lib/types.js';

const listing = <T>(items: T[]) => Readable.from(items);

function fakeMinio(objects: Record<string, Buffer>) {
  const removed: string[][] = [];
  const copied: [string, string][] = [];
  const client = {
    bucketExists: vi.fn(async () => true),
    makeBucket: vi.fn(),
    listObjectsV2: vi.fn((_bucket: string, prefix: string, recursive: boolean) => {
      const under = Object.keys(objects).filter((key) => key.startsWith(prefix));
      if (recursive) return listing(under.map((name) => ({ name })));
      const seen = new Set<string>();
      const items: { name?: string; prefix?: string; size?: number }[] = [];
      for (const key of under) {
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) items.push({ name: key, size: objects[key]!.length });
        else if (!seen.has(rest.slice(0, slash))) { seen.add(rest.slice(0, slash)); items.push({ prefix: `${prefix}${rest.slice(0, slash)}/` }); }
      }
      return listing(items);
    }),
    statObject: vi.fn(async (_bucket: string, key: string) => {
      if (!objects[key]) throw Object.assign(new Error('Not Found'), { code: 'NotFound' });
      return { size: objects[key]!.length, metaData: { 'content-type': 'application/pdf' } };
    }),
    getObject: vi.fn(async (_bucket: string, key: string) => Readable.from([objects[key]!])),
    putObject: vi.fn(async (_bucket: string, key: string, body: Readable | Buffer) => {
      if (Buffer.isBuffer(body)) { objects[key] = body; return; }
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(Buffer.from(part as Buffer));
      objects[key] = Buffer.concat(parts);
    }),
    removeObjects: vi.fn(async (_bucket: string, keys: string[]) => { removed.push(keys); for (const key of keys) delete objects[key]; }),
    copyObject: vi.fn(async (_bucket: string, target: string, source: string) => { copied.push([source, target]); objects[target] = objects[source.replace('/koala-files/', '')]!; }),
  };
  return { client, removed, copied };
}

describe('a project\'s files in MinIO', () => {
  it('lists one folder at a time, folders first, under the project\'s folder only', async () => {
    const { client } = fakeMinio({ 'shop/brief.pdf': Buffer.from('pdf'), 'shop/photos/a.jpg': Buffer.from('a'), 'other/x': Buffer.from('x') });
    const store = minioStore(client as never, 'shop');
    expect(await store.list('')).toEqual([
      { name: 'photos', path: 'photos', type: 'dir' },
      { name: 'brief.pdf', path: 'brief.pdf', type: 'file', size: 3, modified: undefined },
    ]);
    expect(await store.list('photos')).toEqual([{ name: 'a.jpg', path: 'photos/a.jpg', type: 'file', size: 1, modified: undefined }]);
  });

  it('stores, reads back, moves and removes files and whole folders', async () => {
    const objects: Record<string, Buffer> = {};
    const { client } = fakeMinio(objects);
    const store = minioStore(client as never, 'shop');
    await store.upload('docs/a.pdf', Readable.from([Buffer.from([0, 255])]), 2, 'application/pdf');
    expect(objects['shop/docs/a.pdf']).toEqual(Buffer.from([0, 255]));
    const read = await store.download('docs/a.pdf');
    expect(read).toMatchObject({ size: 2, contentType: 'application/pdf' });
    expect(await store.download('nope.pdf')).toBeUndefined();
    await store.move('docs', 'archive/docs');
    expect(Object.keys(objects)).toEqual(['shop/archive/docs/a.pdf']);
    await store.remove('archive');
    expect(objects).toEqual({});
  });

  it('says MinIO did not answer rather than calling a file missing', async () => {
    const { client } = fakeMinio({ 'shop/a.pdf': Buffer.from('a') });
    client.statObject.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const store = minioStore(client as never, 'shop');
    await expect(store.download('a.pdf')).rejects.toThrow('ECONNREFUSED');
    expect(await store.download('a.pdf')).toMatchObject({ size: 1 });
  });

  it('keeps an empty folder with a mark the listing leaves out, and finds files by name anywhere in the project', async () => {
    const objects: Record<string, Buffer> = { 'shop/docs/Client Brief.pdf': Buffer.from('pdf'), 'shop/brief/notes.txt': Buffer.from('n'), 'other/brief.pdf': Buffer.from('x') };
    const { client } = fakeMinio(objects);
    const store = minioStore(client as never, 'shop');
    await store.makeFolder('empty');
    expect(Object.keys(objects)).toContain('shop/empty/.keep');
    expect((await store.list('')).map((entry) => `${entry.type} ${entry.path}`)).toEqual(['dir brief', 'dir docs', 'dir empty']);
    expect(await store.list('empty')).toEqual([]);
    expect((await store.search('brief')).map((entry) => entry.path)).toEqual(['docs/Client Brief.pdf']);
  });

    it('removes everything a project kept, and nothing of another project', async () => {
    const objects = { 'shop/a': Buffer.from('a'), 'shop/b/c': Buffer.from('c'), 'blog/d': Buffer.from('d') };
    const { client } = fakeMinio(objects);
    await minioStore(client as never, 'shop').removeAll();
    expect(Object.keys(objects)).toEqual(['blog/d']);
  });
});

describe('opening a person\'s file server', () => {
  const running = { id: 'm1', name: 'Team Store', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: 'u1', minioRootUser: 'koala', minioRootPassword: 'pw' } as DeploymentMetadata;
  const cluster = { id: 'c1', name: 'dev', provider: 'k3d' } as ClusterMetadata;
  const place = { kind: 'minio' as const, deploymentId: 'm1', folder: 'shop' };

  function reachTo(deployments: DeploymentMetadata[]) {
    const reach = mock<FileStoreReach>();
    reach.deployments.mockResolvedValue(deployments);
    reach.clusterById.calledWith('c1').mockResolvedValue(cluster);
    reach.service.calledWith(cluster, 'team-store', 'minio').mockResolvedValue({ spec: { ports: [{ name: 's3', port: 9000, nodePort: 30900 }] } });
    reach.nodeIp.calledWith(cluster).mockResolvedValue('172.18.0.2');
    return reach;
  }

  it('reaches the server through its service in the namespace named from its app, and hands back a store for the folder', async () => {
    const reach = reachTo([running]);
    const store = await new FileStores(reach).open('u1', place);
    expect(reach.service).toHaveBeenCalledWith(cluster, 'team-store', 'minio');
    expect(Object.keys(store).sort()).toEqual(['download', 'list', 'makeFolder', 'move', 'remove', 'removeAll', 'search', 'upload']);
  });

  it('refuses a server that is not the person\'s, not running, or gone from its cluster, saying which', async () => {
    const message = (reach: FileStoreReach) => new FileStores(reach).open('u1', place).catch((err: Error) => err);
    const others = await message(reachTo([{ ...running, ownerId: 'u2' }]));
    expect(others).toBeInstanceOf(FileServerUnreachableError);
    expect((others as Error).message).toBe('The file server m1 is not running.');
    expect(((await message(reachTo([{ ...running, status: 'failed' }]))) as Error).message).toBe('The file server m1 is not running.');
    const orphan = reachTo([running]);
    orphan.clusterById.calledWith('c1').mockResolvedValue(undefined);
    expect(((await message(orphan)) as Error).message).toBe('The cluster Team Store runs on is gone.');
  });

  it('refuses a server with no address Koala can reach or no stored password', async () => {
    const message = (reach: FileStoreReach) => new FileStores(reach).open('u1', place).catch((err: Error) => err);
    const unaddressed = reachTo([running]);
    unaddressed.service.calledWith(cluster, 'team-store', 'minio').mockResolvedValue({});
    expect(((await message(unaddressed)) as Error).message).toBe('Team Store cannot be reached from Koala.');
    const passwordless = reachTo([{ ...running, minioRootPassword: '' }]);
    expect(((await message(passwordless)) as Error).message).toBe('Team Store cannot be reached from Koala.');
  });
});
