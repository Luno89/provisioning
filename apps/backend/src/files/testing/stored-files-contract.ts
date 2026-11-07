import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DEAD_AFTER_MS, type StoredScope } from '../lib/stored-files.js';
import type { StoredFilesSwept } from '../lib/stored-files-work.js';
import type { ObjectStore } from '../services/ObjectStore.js';
import type { StoredFiles } from '../services/StoredFiles.js';
import type { FilesStore } from '../store.js';

export interface StoredFilesWorld {
  files: StoredFiles;
  objects: ObjectStore;
  records: Pick<FilesStore, 'beginStoredFile' | 'storedFileById'>;
  sweep(): Promise<StoredFilesSwept>;
  clock: { now: number };
}

const bytesOf = async (body: Readable): Promise<Buffer> => {
  const parts: Buffer[] = [];
  for await (const part of body) parts.push(Buffer.isBuffer(part) ? part : Buffer.from(part as string));
  return Buffer.concat(parts);
};

const ids = async (objects: ObjectStore): Promise<string[]> => {
  const found: string[] = [];
  for await (const id of objects.ids()) found.push(id);
  return found.sort();
};

const body = (text: string): Readable => Readable.from([Buffer.from(text)]);

export function storedFilesContract(make: () => Promise<StoredFilesWorld>): void {
  const owner = () => `u-${randomUUID().slice(0, 8)}`;
  const project = (): StoredScope => ({ kind: 'project', id: `p-${randomUUID().slice(0, 8)}` });

  describe('a person\'s stored files, through the one way Koala keeps them', () => {
    it('keeps a file\'s bytes exactly, lists it with its size, finds it by name and gives it back by path and by id', async () => {
      const world = await make();
      const me = owner();
      const folder = world.files.at(me, project());
      const bytes = Buffer.from(Array.from({ length: 300 }, (_unused, n) => n % 256));
      const kept = await folder.upload('reports/q3/summary.pdf', Readable.from([bytes]), bytes.length, 'application/pdf', { replace: true });
      expect(kept).toMatchObject({ ok: true, value: { path: 'reports/q3/summary.pdf', size: 300, version: 1, state: 'stored', contentType: 'application/pdf' } });
      expect(await folder.list('')).toEqual({ ok: true, value: [{ name: 'reports', path: 'reports', type: 'dir' }] });
      const inside = await folder.list('reports/q3');
      expect(inside.ok && inside.value.map((entry) => [entry.name, entry.type, entry.size])).toEqual([['summary.pdf', 'file', 300]]);
      expect((await folder.search('SUMMARY')).map((entry) => entry.path)).toEqual(['reports/q3/summary.pdf']);
      const read = await folder.download('reports/q3/summary.pdf');
      expect(read.ok && await bytesOf(read.value.body)).toEqual(bytes);
      const byId = await world.files.byId(me, kept.ok ? kept.value.id : '');
      expect(byId && await bytesOf(byId.body)).toEqual(bytes);
      expect(await world.files.byId(owner(), kept.ok ? kept.value.id : '')).toBeUndefined();
    });

    it('replaces a file as its next version, keeping its id-to-bytes one to one: the old bytes go', async () => {
      const world = await make();
      const folder = world.files.at(owner(), project());
      const first = await folder.upload('a.txt', body('first'), 5, 'text/plain', { replace: true });
      const second = await folder.upload('a.txt', body('second'), 6, 'text/plain', { replace: true });
      expect(second).toMatchObject({ ok: true, value: { version: 2, size: 6 } });
      const read = await folder.download('a.txt');
      expect(read.ok && (await bytesOf(read.value.body)).toString()).toBe('second');
      expect(await world.objects.stat(first.ok ? first.value.id : '')).toBeUndefined();
      expect(await world.records.storedFileById(first.ok ? first.value.id : '')).toBeUndefined();
    });

    it('refuses to replace a file when it may not, and leaves no trace of the refused upload', async () => {
      const world = await make();
      const folder = world.files.at(owner(), project());
      await folder.upload('a.txt', body('mine'), 4, 'text/plain', { replace: true });
      const before = await ids(world.objects);
      expect(await folder.upload('a.txt', body('theirs'), 6, 'text/plain', { replace: false })).toMatchObject({ ok: false, status: 409 });
      expect(await ids(world.objects)).toEqual(before);
      const read = await folder.download('a.txt');
      expect(read.ok && (await bytesOf(read.value.body)).toString()).toBe('mine');
    });

    it('makes an empty folder that lists, moves a folder with everything in it, and refuses a move onto something there', async () => {
      const world = await make();
      const folder = world.files.at(owner(), project());
      expect(await folder.makeFolder('empty')).toEqual({ ok: true, value: { path: 'empty', made: true } });
      await folder.upload('docs/a.txt', body('a'), 1, 'text/plain', { replace: true });
      await folder.upload('docs/deep/b.txt', body('b'), 1, 'text/plain', { replace: true });
      expect(await folder.move('docs', 'empty/docs')).toEqual({ ok: true, value: { path: 'empty/docs', moved: 2 } });
      const moved = await folder.list('empty/docs');
      expect(moved.ok && moved.value.map((entry) => entry.path)).toEqual(['empty/docs/deep', 'empty/docs/a.txt']);
      expect(await folder.download('docs/a.txt')).toMatchObject({ ok: false, status: 404 });
      await folder.upload('c.txt', body('c'), 1, 'text/plain', { replace: true });
      expect(await folder.move('c.txt', 'empty/docs/a.txt')).toMatchObject({ ok: false, status: 409 });
    });

    it('removes a folder\'s whole subtree, records and bytes, and removing everything leaves the place empty', async () => {
      const world = await make();
      const folder = world.files.at(owner(), project());
      const a = await folder.upload('docs/a.txt', body('a'), 1, 'text/plain', { replace: true });
      await folder.upload('docs/deep/b.txt', body('b'), 1, 'text/plain', { replace: true });
      await folder.upload('keep.txt', body('k'), 1, 'text/plain', { replace: true });
      expect(await folder.remove('docs')).toEqual({ ok: true, value: { path: 'docs', removed: 2 } });
      expect(await world.objects.stat(a.ok ? a.value.id : '')).toBeUndefined();
      const left = await folder.list('');
      expect(left.ok && left.value.map((entry) => entry.path)).toEqual(['keep.txt']);
      expect(await folder.remove('docs')).toMatchObject({ ok: false, status: 404 });
      expect(await folder.removeAll()).toBe(1);
      expect(await folder.list('')).toEqual({ ok: true, value: [] });
    });

    it('moves a chat\'s files under a folder of a project, keeping their ids, so whatever named them by id still finds them', async () => {
      const world = await make();
      const me = owner();
      const chat: StoredScope = { kind: 'conversation', id: `c-${randomUUID().slice(0, 8)}` };
      const target = project();
      const kept = await world.files.at(me, chat).upload('photo.png', body('png'), 3, 'image/png', { replace: true });
      expect(await world.files.moveScope(me, chat, target, `chats/${chat.id}`)).toBe(1);
      expect(await world.files.at(me, chat).list('')).toEqual({ ok: true, value: [] });
      const there = await world.files.at(me, target).download(`chats/${chat.id}/photo.png`);
      expect(there.ok && there.value.record.id).toBe(kept.ok ? kept.value.id : 'missing');
      expect((await world.files.recordById(me, kept.ok ? kept.value.id : ''))?.scope).toEqual(target);
    });

    it('sweeps an upload nobody finished, a run\'s files once expired, and bytes no record names, and nothing else', async () => {
      const world = await make();
      const me = owner();
      const run: StoredScope = { kind: 'run', id: `r-${randomUUID().slice(0, 8)}` };
      const stays = await world.files.at(me, project()).upload('stays.txt', body('s'), 1, 'text/plain', { replace: true });
      const expiring = await world.files.at(me, run).upload('shot.png', body('png'), 3, 'image/png', { replace: true, expiresAt: new Date(world.clock.now + 1000).toISOString() });
      const at = new Date(world.clock.now).toISOString();
      await world.records.beginStoredFile({ id: `dead-${randomUUID()}`, ownerId: me, scope: project(), path: 'dead.txt', kind: 'file', size: 0, contentType: 'text/plain', version: 0, madeAt: at, changedAt: at, state: 'uploading', touchedAt: at });
      const orphan = `orphan-${randomUUID()}`;
      await world.objects.put(orphan, body('lost'), 4, 'text/plain');
      world.clock.now += DEAD_AFTER_MS;
      const swept = await world.sweep();
      expect(swept.deadUploads).toBeGreaterThanOrEqual(1);
      expect(swept.expired).toBeGreaterThanOrEqual(1);
      expect(swept.orphans).toBeGreaterThanOrEqual(1);
      expect(await world.objects.stat(orphan)).toBeUndefined();
      expect(await world.records.storedFileById(expiring.ok ? expiring.value.id : '')).toBeUndefined();
      expect(await world.objects.stat(stays.ok ? stays.value.id : '')).toEqual({ size: 1 });
      expect(await world.records.storedFileById(stays.ok ? stays.value.id : '')).toMatchObject({ state: 'stored' });
    });
  });
}
