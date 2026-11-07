import { describe, expect, it, afterEach } from 'vitest';
import axios from 'axios';
import { filesRouter, FILE_TYPE_HEADER, shareRouter } from './files.js';
import { mountRouter, type Harness, TEST_USER } from '../../platform/routes/test-harness.js';
import { FileService } from '../services/FileService.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { storedFilesOn } from '../testing/stored-files-twin.js';
import type { MemoryObjectStore } from '../testing/memory-object-store.js';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

let shared: FileService | undefined;

async function mount(): Promise<{ harness: Harness; objects: () => MemoryObjectStore }> {
  let objects: MemoryObjectStore | undefined;
  const harness = await mountRouter({
    prefix: '/api/files',
    router: async (db: Database) => {
      await db.projects.saveProjectInfo({ id: 'p1', name: 'Shop', appType: 'gitapp', ownerId: TEST_USER.id, createdAt: 'now' } as never);
      await db.projects.saveProjectInfo({ id: 'p2', name: 'Theirs', appType: 'gitapp', ownerId: 'someone-else', createdAt: 'now' } as never);
      await db.engine.saveConversation({ id: 'c1', ownerId: TEST_USER.id, title: 'A chat', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
      await db.engine.saveConversation({ id: 'channel-p1', ownerId: TEST_USER.id, title: 'Shop', projectId: 'p1', kind: 'channel', messages: [], createdAt: 'now', updatedAt: 'now' } as never);
      const stored = storedFilesOn(db.files);
      objects = stored.objects;
      const files = new FileService({ files: stored.files, shares: db.files });
      shared = files;
      return filesRouter({
        files,
        getOwnedProject: async (id) => (await db.projects.getProjects()).find((project) => project.id === id && project.ownerId === TEST_USER.id),
        getOwnedConversation: async (ownerId, id) => db.engine.getConversation(ownerId, id),
      });
    },
  });
  h = harness;
  return { harness, objects: () => objects! };
}

const put = (harness: Harness, url: string, bytes: Buffer, type: string) =>
  axios.put(harness.url(url), bytes, { headers: { 'Content-Type': 'application/octet-stream', [FILE_TYPE_HEADER]: type }, validateStatus: () => true });

describe('/api/files', () => {
  it('stores a dropped file byte for byte, answers with its id, and gives it back by path and by id', async () => {
    const { harness, objects } = await mount();
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const stored = await put(harness, '/api/files/projects/p1/content?path=docs/brief.pdf', pdf, 'application/pdf');
    expect(stored.status).toBe(201);
    const { id, path } = stored.data as { id: string; path: string };
    expect(path).toBe('docs/brief.pdf');
    expect(objects().kept.get(id)).toEqual({ bytes: pdf, contentType: 'application/pdf' });

    const back = await axios.get(harness.url('/api/files/projects/p1/content?path=docs/brief.pdf'), { responseType: 'arraybuffer' });
    expect(Buffer.from(back.data)).toEqual(pdf);
    expect(back.headers['content-type']).toBe('application/pdf');
    expect(back.headers['content-disposition']).toBe("attachment; filename*=UTF-8''brief.pdf");
    const byId = await axios.get(harness.url(`/api/files/stored/${id}?inline=1`), { responseType: 'arraybuffer' });
    expect(Buffer.from(byId.data)).toEqual(pdf);
    expect(byId.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
    expect((await axios.get(harness.url('/api/files/projects/p1/list?dir=docs'))).data).toMatchObject([{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file', size: 6 }]);
  });

  it('keeps a JSON file as it was sent, never parsed', async () => {
    const { harness, objects } = await mount();
    const text = Buffer.from('{ "a" : 1 }');
    const stored = await put(harness, '/api/files/projects/p1/content?path=data.json', text, 'application/json');
    expect(stored.status).toBe(201);
    expect(objects().kept.get((stored.data as { id: string }).id)?.bytes).toEqual(text);
  });

  it('moves and removes, and refuses a path that leaves the project\'s files', async () => {
    const { harness, objects } = await mount();
    await put(harness, '/api/files/projects/p1/content?path=a.txt', Buffer.from('a'), 'text/plain');
    await axios.post(harness.url('/api/files/projects/p1/move'), { from: 'a.txt', to: 'old/a.txt' });
    expect((await axios.get(harness.url('/api/files/projects/p1/list?dir=old'))).data).toMatchObject([{ path: 'old/a.txt' }]);
    await axios.delete(harness.url('/api/files/projects/p1/content?path=old/a.txt'));
    expect(objects().kept.size).toBe(0);
    expect((await put(harness, '/api/files/projects/p1/content?path=../../x', Buffer.from('x'), 'text/plain')).status).toBe(400);
  });

  it('never reaches another person\'s project or chat, and keeps a person\'s own files apart from their projects', async () => {
    const { harness } = await mount();
    expect((await axios.get(harness.url('/api/files/projects/p2/list'), { validateStatus: () => true })).status).toBe(404);
    expect((await axios.get(harness.url('/api/files/conversations/nobodys/list'), { validateStatus: () => true })).status).toBe(404);
    expect((await put(harness, '/api/files/mine/content?path=photo.jpg', Buffer.from([1, 2]), 'image/jpeg')).status).toBe(201);
    expect((await axios.get(harness.url('/api/files/mine/list'))).data).toMatchObject([{ path: 'photo.jpg' }]);
    expect((await axios.get(harness.url('/api/files/projects/p1/list'))).data).toEqual([]);
  });

  it('keeps a chat\'s files with the chat, and a project chat\'s in its project under the chat\'s folder', async () => {
    const { harness } = await mount();
    expect((await axios.get(harness.url('/api/files/conversations/channel-p1/list'))).data).toEqual([]);
    expect((await put(harness, '/api/files/conversations/c1/content?path=a.png', Buffer.from('a'), 'image/png')).status).toBe(201);
    expect((await put(harness, '/api/files/conversations/channel-p1/content?path=b.png', Buffer.from('b'), 'image/png')).status).toBe(201);
    expect((await axios.get(harness.url('/api/files/conversations/c1/list'))).data).toMatchObject([{ path: 'a.png' }]);
    expect((await axios.get(harness.url('/api/files/conversations/channel-p1/list'))).data).toMatchObject([{ path: 'b.png' }]);
    expect((await axios.get(harness.url('/api/files/projects/p1/list?dir=chats/channel-p1'))).data).toMatchObject([{ path: 'chats/channel-p1/b.png' }]);
    expect((await axios.get(harness.url('/api/files/mine/list'))).data).toEqual([]);
  });

  it('makes a folder, finds files by name, and shares one by a link that follows the file until it is moved or revoked', async () => {
    const { harness } = await mount();
    expect((await axios.post(harness.url('/api/files/projects/p1/folder'), { path: 'empty' })).status).toBe(201);
    expect((await axios.get(harness.url('/api/files/projects/p1/list'))).data).toMatchObject([{ path: 'empty', type: 'dir' }]);
    await put(harness, '/api/files/projects/p1/content?path=docs/brief.pdf', Buffer.from('%PDF'), 'application/pdf');
    await put(harness, '/api/files/projects/p1/content?path=page.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    expect((await axios.get(harness.url('/api/files/projects/p1/search?q=brief'))).data).toMatchObject([{ name: 'brief.pdf', path: 'docs/brief.pdf', type: 'file' }]);

    expect((await axios.post(harness.url('/api/files/projects/p1/shares'), { path: 'docs/brief.pdf', days: 3 }, { validateStatus: () => true })).status).toBe(400);
    const made = (await axios.post(harness.url('/api/files/projects/p1/shares'), { path: 'docs/brief.pdf', days: 7 })).data as { id: string; token: string; name: string; fileId: string };
    expect(made.fileId).toEqual(expect.any(String));
    const page = (await axios.post(harness.url('/api/files/projects/p1/shares'), { path: 'page.html', days: 1 })).data as { id: string; token: string };
    expect(((await axios.get(harness.url('/api/files/shares'))).data as { id: string }[]).map((share) => share.id).sort()).toEqual([made.id, page.id].sort());

    const publicSite = await mountRouter({ db: harness.db, prefix: '/api/share', user: { ...TEST_USER, id: 'a-stranger', email: 'stranger@example.com' }, router: async () => shareRouter({ files: shared! }) });
    try {
      const opened = await axios.get(publicSite.url(`/api/share/${made.token}`), { responseType: 'arraybuffer' });
      expect(Buffer.from(opened.data)).toEqual(Buffer.from('%PDF'));
      expect(opened.headers['content-disposition']).toBe("inline; filename*=UTF-8''brief.pdf");
      expect(opened.headers['content-security-policy']).toBe("frame-ancestors 'self'");
      await put(harness, '/api/files/projects/p1/content?path=docs/brief.pdf', Buffer.from('%PDF-2'), 'application/pdf');
      expect(Buffer.from((await axios.get(publicSite.url(`/api/share/${made.token}`), { responseType: 'arraybuffer' })).data)).toEqual(Buffer.from('%PDF-2'));
      expect((await axios.get(publicSite.url(`/api/share/${page.token}`))).headers['content-security-policy']).toContain('sandbox');
      await axios.post(harness.url('/api/files/projects/p1/move'), { from: 'page.html', to: 'old/page.html' });
      expect((await axios.get(publicSite.url(`/api/share/${page.token}`), { validateStatus: () => true })).status).toBe(404);
      expect((await axios.delete(harness.url(`/api/files/shares/${made.id}`))).status).toBe(200);
      expect((await axios.get(publicSite.url(`/api/share/${made.token}`), { validateStatus: () => true })).status).toBe(404);
    } finally {
      await publicSite.close();
    }
  });
});
