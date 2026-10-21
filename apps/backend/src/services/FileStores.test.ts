import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { minioStore, nextcloudStore, readPropfind, webAddress, type davRequest } from './FileStores.js';

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
      if (!objects[key]) throw new Error('NotFound');
      return { size: objects[key]!.length, metaData: { 'content-type': 'application/pdf' } };
    }),
    getObject: vi.fn(async (_bucket: string, key: string) => Readable.from([objects[key]!])),
    putObject: vi.fn(async (_bucket: string, key: string, body: Readable) => {
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

  it('removes everything a project kept, and nothing of another project', async () => {
    const objects = { 'shop/a': Buffer.from('a'), 'shop/b/c': Buffer.from('c'), 'blog/d': Buffer.from('d') };
    const { client } = fakeMinio(objects);
    await minioStore(client as never, 'shop').removeAll();
    expect(Object.keys(objects)).toEqual(['blog/d']);
  });
});

const PROPFIND = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/remote.php/dav/files/admin/Koala/shop/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/admin/Koala/shop/My%20photos/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype><d:getlastmodified>Tue, 20 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/admin/Koala/shop/brief.pdf</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1234</d:getcontentlength><d:getlastmodified>Tue, 20 Oct 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
</d:multistatus>`;

describe('a project\'s files in Nextcloud', () => {
  it('reads a folder\'s listing, leaving the folder itself out', () => {
    expect(readPropfind(PROPFIND, 'Koala/shop')).toEqual([
      { name: 'My photos', path: 'My photos', type: 'dir', modified: '2026-10-20T10:00:00.000Z' },
      { name: 'brief.pdf', path: 'brief.pdf', type: 'file', size: 1234, modified: '2026-10-20T10:00:00.000Z' },
    ]);
  });

  it('makes the folders a file goes in, then stores it under the project\'s folder, and moves without overwriting', async () => {
    const calls: { method: string; path: string; headers?: Record<string, string> }[] = [];
    const answer = (status: number) => {
      const stream = new PassThrough();
      stream.end();
      return { status, headers: {}, stream } as never;
    };
    const request = (async (_dav, method, path, options = {}) => {
      calls.push({ method, path, ...(options.headers ? { headers: options.headers } : {}) });
      if (method === 'MKCOL') return answer(path === 'Koala' ? 405 : 201);
      if (method === 'PUT') { if (options.body instanceof Readable) options.body.resume(); return answer(201); }
      return answer(201);
    }) as typeof davRequest;
    const store = nextcloudStore({ host: 'h', port: 1, user: 'admin', password: 'pw' }, 'Koala/shop', request);
    await store.upload('docs/a.pdf', Readable.from([Buffer.from('x')]), 1, 'application/pdf');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['MKCOL Koala', 'MKCOL Koala/shop', 'MKCOL Koala/shop/docs', 'PUT Koala/shop/docs/a.pdf']);
    calls.length = 0;
    await store.move('docs/a.pdf', 'old/a.pdf');
    expect(calls.at(-1)).toEqual({ method: 'MOVE', path: 'Koala/shop/docs/a.pdf', headers: { Destination: 'http://nextcloud/remote.php/dav/files/admin/Koala/shop/old/a.pdf', Overwrite: 'F' } });
  });
});

describe('reaching a web server in a cluster', () => {
  it('takes its node port on the node, or its load balancer', () => {
    expect(webAddress({ spec: { ports: [{ port: 80, nodePort: 31080 }] } }, '10.0.0.2')).toEqual({ host: '10.0.0.2', port: 31080 });
    expect(webAddress({ spec: { ports: [{ name: 'http', port: 8080 }] }, status: { loadBalancer: { ingress: [{ ip: '1.2.3.4' }] } } }, undefined)).toEqual({ host: '1.2.3.4', port: 8080 });
    expect(webAddress({ spec: { ports: [{ port: 443 }] } }, '10.0.0.2')).toBeUndefined();
  });
});
