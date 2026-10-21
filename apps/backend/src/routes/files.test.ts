import { describe, expect, it, afterEach } from 'vitest';
import axios from 'axios';
import { Readable } from 'node:stream';
import { filesRouter, FILE_TYPE_HEADER } from './files.js';
import { mountRouter, type Harness, TEST_USER } from './test-harness.js';
import { FileService } from '../services/FileService.js';
import type { FileStore } from '../services/FileStores.js';
import type { Database } from '../lib/db-interface.js';
import type { FileEntry } from '../lib/file-places.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

function memoryStore(kept: Map<string, { bytes: Buffer; type: string }>, folder: string): FileStore {
  const key = (path: string) => `${folder}/${path}`;
  return {
    list: async (dir) => [...kept.keys()].filter((name) => name.startsWith(key(dir ? `${dir}/` : ''))).map((name): FileEntry => ({ name: name.split('/').pop()!, path: name.slice(folder.length + 1), type: 'file', size: kept.get(name)!.bytes.length })),
    download: async (path) => {
      const found = kept.get(key(path));
      return found ? { stream: Readable.from([found.bytes]), size: found.bytes.length, contentType: found.type } : undefined;
    },
    upload: async (path, body, _size, type) => {
      const parts: Buffer[] = [];
      for await (const part of body) parts.push(Buffer.from(part as Buffer));
      kept.set(key(path), { bytes: Buffer.concat(parts), type });
    },
    remove: async (path) => { kept.delete(key(path)); },
    move: async (from, to) => { kept.set(key(to), kept.get(key(from))!); kept.delete(key(from)); },
    removeAll: async () => { for (const name of [...kept.keys()]) if (name.startsWith(`${folder}/`)) kept.delete(name); },
  };
}

async function mount(): Promise<{ harness: Harness; kept: Map<string, { bytes: Buffer; type: string }> }> {
  const kept = new Map<string, { bytes: Buffer; type: string }>();
  const harness = await mountRouter({
    prefix: '/api/files',
    router: async (db: Database) => {
      await db.saveDeployment({ id: 'm1', name: 'minio', appType: 'minio', status: 'running', clusterId: 'c1', ownerId: TEST_USER.id, minioRootPassword: 'pw', strategy: 'native' } as never);
      await db.saveProjectInfo({ id: 'p1', name: 'Shop', appType: 'gitapp', ownerId: TEST_USER.id, createdAt: 'now' } as never);
      await db.saveProjectInfo({ id: 'p2', name: 'Theirs', appType: 'gitapp', ownerId: 'someone-else', createdAt: 'now' } as never);
      const files = new FileService({ store: db, open: async (_ownerId, place) => memoryStore(kept, place.folder), deployMinio: async () => ({ deploymentId: 'x' }), defaultCluster: 'c1' });
      return filesRouter({
        files,
        getOwnedProject: async (id) => (await db.getProjects()).find((project) => project.id === id && project.ownerId === TEST_USER.id),
      });
    },
  });
  h = harness;
  return { harness, kept };
}

const put = (harness: Harness, url: string, bytes: Buffer, type: string) =>
  axios.put(harness.url(url), bytes, { headers: { 'Content-Type': 'application/octet-stream', [FILE_TYPE_HEADER]: type }, validateStatus: () => true });

describe('/api/files', () => {
  it('stores a dropped file byte for byte once the project has a server, and gives it back', async () => {
    const { harness, kept } = await mount();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    expect((await put(harness, '/api/files/projects/p1/content?path=brief.pdf', pdf, 'application/pdf')).status).toBe(409);

    expect((await axios.put(harness.url('/api/files/projects/p1/place'), { deploymentId: 'm1' })).data).toMatchObject({ state: 'ready', place: { folder: 'shop' } });
    const stored = await put(harness, '/api/files/projects/p1/content?path=docs/brief.pdf', pdf, 'application/pdf');
    expect(stored.status).toBe(201);
    expect(kept.get('shop/docs/brief.pdf')).toEqual({ bytes: pdf, type: 'application/pdf' });

    const back = await axios.get(harness.url('/api/files/projects/p1/content?path=docs/brief.pdf'), { responseType: 'arraybuffer' });
    expect(Buffer.from(back.data)).toEqual(pdf);
    expect(back.headers['content-type']).toBe('application/pdf');
    expect(back.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
    expect((await axios.get(harness.url('/api/files/projects/p1/list?dir=docs'))).data).toEqual([{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file', size: 6 }]);
  });

  it('keeps a JSON file as it was sent, never parsed', async () => {
    const { harness, kept } = await mount();
    await axios.put(harness.url('/api/files/projects/p1/place'), { deploymentId: 'm1' });
    const text = Buffer.from('{ "a" : 1 }');
    expect((await put(harness, '/api/files/projects/p1/content?path=data.json', text, 'application/json')).status).toBe(201);
    expect(kept.get('shop/data.json')?.bytes).toEqual(text);
  });

  it('moves and removes, and refuses a path that leaves the project\'s files', async () => {
    const { harness, kept } = await mount();
    await axios.put(harness.url('/api/files/projects/p1/place'), { deploymentId: 'm1' });
    await put(harness, '/api/files/projects/p1/content?path=a.txt', Buffer.from('a'), 'text/plain');
    await axios.post(harness.url('/api/files/projects/p1/move'), { from: 'a.txt', to: 'old/a.txt' });
    expect([...kept.keys()]).toEqual(['shop/old/a.txt']);
    await axios.delete(harness.url('/api/files/projects/p1/content?path=old/a.txt'));
    expect(kept.size).toBe(0);
    expect((await put(harness, '/api/files/projects/p1/content?path=../../x', Buffer.from('x'), 'text/plain')).status).toBe(400);
  });

  it('never reaches another person\'s project, and keeps a person\'s own files in their default server', async () => {
    const { harness, kept } = await mount();
    expect((await axios.get(harness.url('/api/files/projects/p2/list'), { validateStatus: () => true })).status).toBe(404);
    expect((await axios.put(harness.url('/api/files/default'), { deploymentId: 'm1' })).data).toEqual({ defaultId: 'm1' });
    expect((await put(harness, '/api/files/mine/content?path=chats/c1/photo.jpg', Buffer.from([1, 2]), 'image/jpeg')).status).toBe(201);
    expect([...kept.keys()]).toEqual(['personal/chats/c1/photo.jpg']);
    expect((await axios.get(harness.url('/api/files/servers'))).data).toEqual({ servers: [{ kind: 'minio', deploymentId: 'm1', name: 'minio', clusterId: 'c1' }], defaultId: 'm1' });
  });
});
