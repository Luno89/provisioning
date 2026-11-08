import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FileService } from '../services/FileService.js';
import type { StoredFiles } from '../services/StoredFiles.js';
import type { FilesStore } from '../store.js';
import { dropBody } from '../lib/drops.js';
import type { FileScope } from '../lib/file-places.js';

export interface FileServiceWorld {
  files: Pick<StoredFiles, 'at' | 'byId' | 'recordById' | 'room'>;
  shares: FilesStore;
}

const bytesOf = async (body: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.from(part as Buffer));
  return Buffer.concat(parts);
};

const body = (text: string): Readable => Readable.from([Buffer.from(text)]);

export function fileServiceBehaviour(make: () => Promise<FileServiceWorld>): void {
  const setUp = async () => {
    const world = await make();
    const clock = { now: '2026-10-21T10:00:00.000Z' };
    const me = `u-${randomUUID().slice(0, 8)}`;
    const project: FileScope = { kind: 'project', project: { id: `p-${randomUUID().slice(0, 8)}` } };
    const service = new FileService({ files: world.files, shares: world.shares, now: () => clock.now });
    const kept = async (scope: FileScope, path: string, text: string, type = 'text/plain') => {
      const stored = await service.upload(me, scope, path, body(text), Buffer.byteLength(text), type, { replace: true });
      if (!stored.ok) throw new Error(stored.why);
      return stored.value;
    };
    return { world, clock, me, project, service, kept };
  };

  describe('a scope\'s files, kept as stored files', () => {
    it('stores an upload, answering with its path and id, and gives it back by path and by id', async () => {
      const { service, me, project, kept } = await setUp();
      const stored = await kept(project, 'docs/brief.pdf', '%PDF', 'application/pdf');
      expect(stored.path).toBe('docs/brief.pdf');
      const back = await service.download(me, project, 'docs/brief.pdf');
      if (!back.ok) throw new Error(back.why);
      expect([back.value.contentType, back.value.size, (await bytesOf(back.value.stream)).toString()]).toEqual(['application/pdf', 4, '%PDF']);
      const byId = await service.downloadById(me, stored.id);
      if (!byId.ok) throw new Error(byId.why);
      expect([byId.value.name, (await bytesOf(byId.value.stream)).toString()]).toEqual(['brief.pdf', '%PDF']);
      expect(await service.downloadById('someone-else', stored.id)).toEqual({ ok: false, status: 404, why: 'You keep no file with that id.' });
      expect(await service.download(me, project, 'missing.pdf')).toEqual({ ok: false, status: 404, why: 'There is no file missing.pdf.' });
    });

    it('replaces a file uploaded again at its path, keeping its id, so what was attached by it opens the new version', async () => {
      const { service, me, project, kept } = await setUp();
      const first = await kept(project, 'a.txt', 'one');
      const second = await kept(project, 'a.txt', 'second');
      expect(second.id).toBe(first.id);
      const listed = await service.list(me, project, '');
      expect(listed).toMatchObject({ ok: true, value: [{ path: 'a.txt', size: 6 }] });
      expect((await service.attachable(me, first.id))?.size).toBe(6);
      const byId = await service.downloadById(me, first.id);
      if (!byId.ok) throw new Error(byId.why);
      expect((await bytesOf(byId.value.stream)).toString()).toBe('second');
    });

    it('refuses to overwrite a file unless told to, naming it as the person sees it and leaving it as it was', async () => {
      const { service, me, project, kept } = await setUp();
      const projectId = project.kind === 'project' ? project.project.id : '';
      const channel: FileScope = { kind: 'conversation', conversationId: 'channel-y', projectId };
      const first = await kept(channel, 'a.txt', 'one');
      expect(await service.upload(me, channel, 'a.txt', body('two'), 3, 'text/plain', { replace: false })).toEqual({ ok: false, status: 409, why: 'a.txt is already there', exists: true });
      const still = await service.download(me, channel, 'a.txt');
      if (!still.ok) throw new Error(still.why);
      expect((await bytesOf(still.value.stream)).toString()).toBe('one');
      expect(await service.upload(me, channel, 'b.txt', body('b'), 1, 'text/plain', { replace: false })).toMatchObject({ ok: true, value: { path: 'b.txt' } });
      expect(await service.upload(me, channel, 'a.txt', body('two'), 3, 'text/plain', { replace: true })).toEqual({ ok: true, value: { path: 'a.txt', id: first.id } });
    });

    it('lists each file with its id, and folders with none', async () => {
      const { service, me, project, kept } = await setUp();
      const a = await kept(project, 'docs/a.txt', 'a');
      const listed = await service.list(me, project, 'docs');
      expect(listed).toMatchObject({ ok: true, value: [{ id: a.id, path: 'docs/a.txt', type: 'file' }] });
      const root = await service.list(me, project, '');
      expect(root.ok && root.value[0]).toEqual({ name: 'docs', path: 'docs', type: 'dir' });
      expect(await service.search(me, project, 'a.txt')).toMatchObject({ ok: true, value: [{ id: a.id, path: 'docs/a.txt' }] });
    });

    it('keeps a drop of several files where it was dropped, each byte for byte under an id of its own', async () => {
      const { service, me } = await setUp();
      const chat: FileScope = { kind: 'conversation', conversationId: `c-${randomUUID().slice(0, 8)}` };
      const png = Buffer.from([0x89, 0x50, 0x0a, 0x00, 0xff]);
      const drop = dropBody({ dir: 'shots' }, [{ path: 'a.png', bytes: png }, { path: 'deep/b.txt', bytes: Buffer.from('b'), type: 'text/markdown' }, { path: 'empty.txt', bytes: Buffer.alloc(0) }]);
      const dropped = await service.drop(me, chat, Readable.from([drop]), drop.length);
      if (!dropped.ok) throw new Error(dropped.why);
      expect(dropped.value.files.map((file) => file.path)).toEqual(['shots/a.png', 'shots/deep/b.txt', 'shots/empty.txt']);
      expect(new Set(dropped.value.files.map((file) => file.id)).size).toBe(3);
      const a = await service.download(me, chat, 'shots/a.png');
      if (!a.ok) throw new Error(a.why);
      expect([a.value.contentType, await bytesOf(a.value.stream)]).toEqual(['image/png', png]);
      const b = await service.downloadById(me, dropped.value.files[1]!.id);
      if (!b.ok) throw new Error(b.why);
      expect([b.value.contentType, (await bytesOf(b.value.stream)).toString()]).toEqual(['text/markdown', 'b']);
      expect(await service.list(me, chat, 'shots')).toMatchObject({ ok: true, value: [{ path: 'shots/deep', type: 'dir' }, { path: 'shots/a.png', size: 5 }, { path: 'shots/empty.txt', size: 0 }] });
    });

    it('refuses a drop naming every file already there, keeping none of it, and keeps it all when told to replace', async () => {
      const { service, me, project, kept } = await setUp();
      const a = await kept(project, 'a.txt', 'old a');
      await kept(project, 'c/d.txt', 'old d');
      const files = ['a.txt', 'b.txt', 'c/d.txt'].map((path) => ({ path, bytes: Buffer.from(`new ${path}`) }));
      const refused = await service.drop(me, project, Readable.from([dropBody({}, files)]), undefined);
      expect(refused).toEqual({ ok: false, status: 409, why: '2 files are already there: a.txt, c/d.txt', exists: ['a.txt', 'c/d.txt'] });
      expect(await service.download(me, project, 'b.txt')).toMatchObject({ ok: false, status: 404 });
      const stillA = await service.download(me, project, 'a.txt');
      expect(stillA.ok && (await bytesOf(stillA.value.stream)).toString()).toBe('old a');
      const replaced = await service.drop(me, project, Readable.from([dropBody({ replace: true }, files)]), undefined);
      if (!replaced.ok) throw new Error(replaced.why);
      expect(replaced.value.files.find((file) => file.path === 'a.txt')?.id).toBe(a.id);
      const newA = await service.download(me, project, 'a.txt');
      expect(newA.ok && (await bytesOf(newA.value.stream)).toString()).toBe('new a.txt');
    });

    it('refuses a drop larger than the room left before keeping any of it, and a drop that is not one', async () => {
      const { service, me, project } = await setUp();
      const free = (await service.room()).free;
      expect(free).toBeGreaterThan(0);
      const drop = dropBody({}, [{ path: 'a.txt', bytes: Buffer.from('a') }]);
      expect(await service.drop(me, project, Readable.from([drop]), free * 2)).toMatchObject({ ok: false, status: 507, needed: free * 2 });
      expect(await service.drop(me, project, Readable.from([dropBody({}, [])]), undefined)).toEqual({ ok: false, status: 400, why: 'nothing was dropped' });
      expect(await service.list(me, project, '')).toEqual({ ok: true, value: [] });
    });

    it('lists, searches, makes folders, moves and removes, refusing what is not there', async () => {
      const { service, me, project, kept } = await setUp();
      await kept(project, 'docs/brief.pdf', 'b');
      expect(await service.makeFolder(me, project, 'empty')).toEqual({ ok: true, value: { path: 'empty' } });
      expect(await service.list(me, project, '')).toMatchObject({ ok: true, value: [{ path: 'docs', type: 'dir' }, { path: 'empty', type: 'dir' }] });
      expect(await service.search(me, project, 'brief')).toMatchObject({ ok: true, value: [{ path: 'docs/brief.pdf' }] });
      expect(await service.search(me, project, '   ')).toEqual({ ok: true, value: [] });
      expect(await service.move(me, project, 'docs/brief.pdf', 'old/brief.pdf')).toEqual({ ok: true, value: { path: 'old/brief.pdf' } });
      expect(await service.move(me, project, 'nope.pdf', 'b.pdf')).toMatchObject({ ok: false, status: 404 });
      expect(await service.remove(me, project, 'old')).toEqual({ ok: true, value: { path: 'old' } });
      expect(await service.remove(me, project, 'old')).toMatchObject({ ok: false, status: 404 });
      expect(await service.list(me, project, 'nowhere')).toMatchObject({ ok: false, status: 404 });
    });

    it('keeps a person\'s own files, a chat\'s and a project chat\'s each where they belong', async () => {
      const { service, me, project, kept } = await setUp();
      const projectId = project.kind === 'project' ? project.project.id : '';
      const chat: FileScope = { kind: 'conversation', conversationId: 'c1' };
      const channel: FileScope = { kind: 'conversation', conversationId: 'channel-x', projectId };
      expect(await service.list(me, channel, '')).toEqual({ ok: true, value: [] });
      await kept({ kind: 'person' }, 'mine.txt', 'm');
      await kept(chat, 'chat.txt', 'c');
      const inChannel = await kept(channel, 'shot.png', 's', 'image/png');
      expect(inChannel.path).toBe('shot.png');
      expect(await service.list(me, { kind: 'person' }, '')).toMatchObject({ value: [{ path: 'mine.txt' }] });
      expect(await service.list(me, chat, '')).toMatchObject({ value: [{ path: 'chat.txt' }] });
      expect(await service.list(me, channel, '')).toMatchObject({ value: [{ path: 'shot.png' }] });
      expect(await service.list(me, project, 'chats/channel-x')).toMatchObject({ value: [{ path: 'chats/channel-x/shot.png' }] });
      expect(await service.search(me, channel, 'shot')).toMatchObject({ value: [{ path: 'shot.png' }] });
      expect(await service.attachable(me, inChannel.id)).toEqual({ id: inChannel.id, path: 'chats/channel-x/shot.png', size: 1, contentType: 'image/png', projectId });
      const download = await service.download(me, channel, 'shot.png');
      expect(download.ok).toBe(true);
      if (download.ok) download.value.stream.destroy();
    });

    it('describes only the person\'s own files for attaching', async () => {
      const { service, me, kept } = await setUp();
      const mine = await kept({ kind: 'person' }, 'a.txt', 'a');
      expect(await service.attachable(me, mine.id)).toEqual({ id: mine.id, path: 'a.txt', size: 1, contentType: 'text/plain' });
      expect(await service.attachable('someone-else', mine.id)).toBeUndefined();
      expect(await service.attachable(me, 'never')).toBeUndefined();
    });

    it('removes everything a project keeps, and nothing of another', async () => {
      const { service, me, project, kept } = await setUp();
      await kept(project, 'a.txt', 'a');
      await kept(project, 'chats/c1/b.txt', 'b');
      await kept({ kind: 'person' }, 'mine.txt', 'm');
      const projectId = project.kind === 'project' ? project.project.id : '';
      expect(await service.removeProjectFiles(me, projectId)).toBe(2);
      expect(await service.list(me, project, '')).toEqual({ ok: true, value: [] });
      expect(await service.list(me, { kind: 'person' }, '')).toMatchObject({ value: [{ path: 'mine.txt' }] });
      expect(await service.removeProjectFiles(me, projectId)).toBe(0);
    });
  });

  describe('share links', () => {
    it('shares one file by a link that serves it to anyone until it expires, and only the person can see or revoke it', async () => {
      const { service, me, project, clock, kept } = await setUp();
      const stored = await kept(project, 'a.pdf', '%PDF', 'application/pdf');
      expect(await service.share(me, project, 'nope.pdf', 7)).toMatchObject({ ok: false, status: 404 });
      const made = await service.share(me, project, 'a.pdf', 1);
      if (!made.ok) throw new Error(made.why);
      expect(made.value).toMatchObject({ ownerId: me, projectId: project.kind === 'project' ? project.project.id : '', fileId: stored.id, path: 'a.pdf', name: 'a.pdf', expiresAt: '2026-10-22T10:00:00.000Z' });
      expect(made.value.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(made.value.id).not.toBe(made.value.token);
      expect(await service.shared(made.value.id)).toMatchObject({ ok: false, status: 404 });
      const served = await service.shared(made.value.token);
      if (!served.ok) throw new Error(served.why);
      expect([served.value.name, served.value.contentType, (await bytesOf(served.value.stream)).toString()]).toEqual(['a.pdf', 'application/pdf', '%PDF']);
      expect((await service.shares(me)).map((share) => share.id)).toEqual([made.value.id]);
      expect(await service.shares('someone-else')).toEqual([]);
      expect(await service.unshare('someone-else', made.value.id)).toMatchObject({ ok: false, status: 404 });

      clock.now = '2026-10-22T10:00:01.000Z';
      expect(await service.shared(made.value.token)).toMatchObject({ ok: false, status: 404 });
      expect(await service.shares(me)).toEqual([]);
      expect(await service.shared('../../etc/passwd')).toMatchObject({ ok: false, status: 404 });
    });

    it('follows its file to a new version, and opens nothing once the file is moved or removed', async () => {
      const { service, me, project, kept } = await setUp();
      await kept(project, 'a.pdf', 'one');
      await kept(project, 'b.pdf', 'b');
      const a = await service.share(me, project, 'a.pdf', 7);
      const b = await service.share(me, project, 'b.pdf', 7);
      if (!a.ok || !b.ok) throw new Error('not shared');
      await kept(project, 'a.pdf', 'second');
      const served = await service.shared(a.value.token);
      if (!served.ok) throw new Error(served.why);
      expect((await bytesOf(served.value.stream)).toString()).toBe('second');
      await service.move(me, project, 'a.pdf', 'old/a.pdf');
      expect(await service.shared(a.value.token)).toMatchObject({ ok: false, status: 404 });
      await service.remove(me, project, 'b.pdf');
      expect(await service.shared(b.value.token)).toMatchObject({ ok: false, status: 404 });
    });

    it('opens nothing for a link made before links followed their file', async () => {
      const { world, service, me } = await setUp();
      const token = 'abcdefghijklmnopqrstuvwxyz012345';
      await world.shares.saveFileShare({ id: `old-${me}`, token, ownerId: me, path: 'a.pdf', name: 'a.pdf', createdAt: '2026-10-21T09:00:00.000Z', expiresAt: '2026-10-28T09:00:00.000Z' });
      expect(await service.shared(token)).toEqual({ ok: false, status: 404, why: 'This link was made for a file Koala no longer keeps, so it opens nothing.' });
      await world.shares.deleteFileShare(`old-${me}`);
    });
  });
}
