import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { sameScope, TOUCH_EVERY_MS, type StoredFileRecord, type StoredScope } from '../lib/stored-files.js';
import type { ObjectStore } from './ObjectStore.js';
import { Folder, StoredFiles, type StoredFileCommits, type StoredFileRecords } from './StoredFiles.js';

const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const AT = new Date(T0).toISOString();
const PROJECT: StoredScope = { kind: 'project', id: 'p1' };

const file = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, ownerId: 'u1', scope: { ...PROJECT }, path, kind: 'file', size: 3, contentType: 'text/plain', version: 1,
  madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT, ...extra,
});
const folder = (id: string, path: string): StoredFileRecord => file(id, path, { kind: 'folder', size: 0, contentType: 'inode/directory' });

const drained = async (stream: Readable): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts).toString();
};

const setUp = (records: StoredFileRecord[] = [], clock: { now: number } = { now: T0 }) => {
  const store = mock<StoredFileRecords>();
  const objects = mock<ObjectStore>();
  const commits = mock<StoredFileCommits>();
  store.storedFilesIn.calledWith('u1', matches<StoredScope>((scope) => sameScope(scope, PROJECT))).mockResolvedValue(records);
  const ids = ['id-1', 'id-2', 'id-3'];
  const service = new StoredFiles({ records: store, objects, commits, now: () => clock.now, newId: () => ids.shift()! });
  return { store, objects, commits, service, folder: service.at('u1', PROJECT), clock };
};

const storing = (objects: ReturnType<typeof setUp>['objects'], size = 5): { sent: Promise<string> } => {
  let resolve: (value: string) => void = () => undefined;
  const sent = new Promise<string>((done) => { resolve = done; });
  objects.put.mockImplementation(async (_id, body) => { resolve(await drained(body)); });
  objects.stat.mockResolvedValue({ size });
  return { sent };
};

describe('the stored files service', () => {
  it('opens a folder for a known place, copying the scope it was given', () => {
    const { service } = setUp();
    const scope: StoredScope = { kind: 'conversation', id: 'c1' };
    const opened = service.at('u2', scope);
    expect(opened).toBeInstanceOf(Folder);
    expect(opened.ownerId).toBe('u2');
    expect(opened.scope).toEqual(scope);
    expect(opened.scope).not.toBe(scope);
  });

  it('refuses to open a place files are not kept, or one with no id', () => {
    const { service } = setUp();
    expect(() => service.at('u1', { kind: 'tree' as never, id: 'x' })).toThrow('tree is not a place files are kept');
    expect(() => service.at('u1', { kind: 'run', id: ' ' })).toThrow('a run\'s files need the run\'s id');
  });

  it('works without a clock or ids handed to it', async () => {
    const store = mock<StoredFileRecords>();
    const service = new StoredFiles({ records: store, objects: mock<ObjectStore>(), commits: mock<StoredFileCommits>() });
    store.makeStoredFolder.mockResolvedValue({ ok: true, made: true });
    await service.at('u1', PROJECT).makeFolder('a');
    const made = store.makeStoredFolder.mock.calls[0]![0];
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(Date.parse(made.madeAt) - Date.now())).toBeLessThan(60_000);
  });

  describe('by id', () => {
    it('hands over a stored file of the owner with its bytes', async () => {
      const { service, store, objects } = setUp();
      const record = file('f1', 'a.txt');
      const body = Readable.from(['abc']);
      store.storedFileById.calledWith('f1').mockResolvedValue(record);
      objects.get.calledWith('f1').mockResolvedValue(body);
      expect(await service.byId('u1', 'f1')).toEqual({ record, body });
    });

    it('hands over nothing that is missing, another owner\'s, still uploading or a folder, never reading bytes', async () => {
      const { service, store, objects } = setUp();
      store.storedFileById.calledWith('other').mockResolvedValue(file('other', 'a', { ownerId: 'u2' }));
      store.storedFileById.calledWith('up').mockResolvedValue(file('up', 'a', { state: 'uploading' }));
      store.storedFileById.calledWith('dir').mockResolvedValue(folder('dir', 'a'));
      for (const id of ['missing', 'other', 'up', 'dir']) expect(await service.byId('u1', id)).toBeUndefined();
      expect(objects.get).not.toHaveBeenCalled();
    });

    it('gives a stored record of the owner, a folder included', async () => {
      const { service, store } = setUp();
      store.storedFileById.calledWith('dir').mockResolvedValue(folder('dir', 'a'));
      expect(await service.recordById('u1', 'dir')).toEqual(folder('dir', 'a'));
    });

    it('gives no record that is missing, another owner\'s or still uploading', async () => {
      const { service, store } = setUp();
      store.storedFileById.calledWith('other').mockResolvedValue(file('other', 'a', { ownerId: 'u2' }));
      store.storedFileById.calledWith('up').mockResolvedValue(file('up', 'a', { state: 'uploading' }));
      for (const id of ['missing', 'other', 'up']) expect(await service.recordById('u1', id)).toBeUndefined();
    });
  });

  describe('moving files to another place', () => {
    it('moves them under the folder named, at the time now, and says how many went', async () => {
      const { service, store } = setUp();
      const to: StoredScope = { kind: 'project', id: 'p2' };
      store.moveStoredScope.mockResolvedValue(4);
      expect(await service.moveScope('u1', PROJECT, to, 'from-chat')).toBe(4);
      expect(store.moveStoredScope).toHaveBeenCalledWith('u1', PROJECT, to, 'from-chat', AT);
    });

    it('moves to the same id in another kind of place', async () => {
      const { service, store } = setUp();
      store.moveStoredScope.mockResolvedValue(0);
      expect(await service.moveScope('u1', PROJECT, { kind: 'person', id: 'p1' }, '')).toBe(0);
    });

    it('refuses a bad place on either side and the place the files are in, moving nothing', async () => {
      const { service, store } = setUp();
      await expect(service.moveScope('u1', { kind: 'x' as never, id: 'a' }, PROJECT, '')).rejects.toThrow('x is not a place files are kept');
      await expect(service.moveScope('u1', PROJECT, { kind: 'person', id: '' }, '')).rejects.toThrow('a person\'s files need the person\'s id');
      await expect(service.moveScope('u1', PROJECT, { ...PROJECT }, '')).rejects.toThrow('files cannot be moved into the place they are in');
      expect(store.moveStoredScope).not.toHaveBeenCalled();
    });
  });
});

describe('a folder of stored files', () => {
  describe('listing', () => {
    it('lists the root even when nothing is kept', async () => {
      const { folder: place } = setUp([]);
      expect(await place.list('/')).toEqual({ ok: true, value: [] });
    });

    it('lists a folder something is in', async () => {
      const { folder: place } = setUp([file('1', 'docs/a.txt')]);
      expect(await place.list('docs')).toEqual({ ok: true, value: [{ name: 'a.txt', path: 'docs/a.txt', type: 'file', size: 3, modified: AT }] });
    });

    it('lists an empty folder by its own record', async () => {
      const { folder: place } = setUp([folder('1', 'docs')]);
      expect(await place.list('docs/')).toEqual({ ok: true, value: [] });
    });

    it('refuses a folder that is not there, and a file as a folder', async () => {
      const { folder: place } = setUp([file('1', 'a.txt')]);
      expect(await place.list('nope')).toEqual({ ok: false, status: 404, why: 'nope is not a folder here' });
      expect(await place.list('a.txt')).toEqual({ ok: false, status: 404, why: 'a.txt is not a folder here' });
    });

    it('refuses a path that is not one without reading the records', async () => {
      const { folder: place, store } = setUp();
      expect(await place.list('../x')).toEqual({ ok: false, status: 400, why: '../x would leave the project\'s files' });
      expect(store.storedFilesIn).not.toHaveBeenCalled();
    });
  });

  it('searches the place\'s files by name', async () => {
    const { folder: place } = setUp([file('1', 'a/report.txt'), file('2', 'b.txt')]);
    expect((await place.search('REP')).map((entry) => entry.path)).toEqual(['a/report.txt']);
  });

  describe('finding and downloading', () => {
    it('finds a file by its cleaned path, never a folder at it', async () => {
      const { folder: place } = setUp([folder('d', 'a'), file('f', 'b/c.txt')]);
      expect(await place.find('/b//c.txt')).toEqual(file('f', 'b/c.txt'));
      expect(await place.find('a')).toBeUndefined();
      expect(await place.find('missing')).toBeUndefined();
    });

    it('finds nothing for a path that is not one, without reading the records', async () => {
      const { folder: place, store } = setUp();
      expect(await place.find('')).toBeUndefined();
      expect(store.storedFilesIn).not.toHaveBeenCalled();
    });

    it('downloads a file with its bytes', async () => {
      const { folder: place, objects } = setUp([file('f', 'a.txt')]);
      const body = Readable.from(['x']);
      objects.get.calledWith('f').mockResolvedValue(body);
      expect(await place.download('a.txt')).toEqual({ ok: true, value: { record: file('f', 'a.txt'), body } });
    });

    it('refuses to download a bad path or one nothing is at', async () => {
      const { folder: place, objects } = setUp([folder('d', 'a')]);
      expect(await place.download('..')).toEqual({ ok: false, status: 400, why: '.. would leave the project\'s files' });
      expect(await place.download('a')).toEqual({ ok: false, status: 404, why: 'a is not here' });
      expect(objects.get).not.toHaveBeenCalled();
    });
  });

  describe('uploading', () => {
    it('begins an upload record, streams the bytes, commits their size and hands back the stored record', async () => {
      const { folder: place, store, objects, commits } = setUp();
      const { sent } = storing(objects, 5);
      const stored = file('id-1', 'docs/a.txt', { size: 5 });
      commits.commit.mockResolvedValue({ ok: true, stored: [stored], replaced: [] });
      const outcome = await place.upload('/docs/a.txt', Readable.from([Buffer.from('hello')]), 5, 'text/plain', { replace: false });
      expect(outcome).toEqual({ ok: true, value: stored });
      expect(store.beginStoredFile).toHaveBeenCalledWith({
        id: 'id-1', ownerId: 'u1', scope: PROJECT, path: 'docs/a.txt', kind: 'file', size: 0, contentType: 'text/plain',
        version: 0, madeAt: AT, changedAt: AT, state: 'uploading', touchedAt: AT,
      });
      expect(store.beginStoredFile.mock.calls[0]![0]).not.toHaveProperty('expiresAt');
      expect(await sent).toBe('hello');
      expect(objects.put).toHaveBeenCalledWith('id-1', expect.anything(), 5, 'text/plain');
      expect(objects.stat).toHaveBeenCalledWith('id-1');
      expect(commits.commit).toHaveBeenCalledWith('u1', [{ id: 'id-1', size: 5 }], { replace: false });
      expect(store.beginStoredFile.mock.invocationCallOrder[0]!).toBeLessThan(objects.put.mock.invocationCallOrder[0]!);
    });

    it('commits the size the bytes really have, not the size it was told', async () => {
      const { folder: place, objects, commits } = setUp();
      storing(objects, 9);
      commits.commit.mockResolvedValue({ ok: true, stored: [file('id-1', 'a')], replaced: [] });
      await place.upload('a', Readable.from(['x']), undefined, 'text/plain', { replace: true });
      expect(objects.put).toHaveBeenCalledWith('id-1', expect.anything(), undefined, 'text/plain');
      expect(commits.commit).toHaveBeenCalledWith('u1', [{ id: 'id-1', size: 9 }], { replace: true });
    });

    it('keeps when the file expires only when one is given', async () => {
      const { folder: place, store, objects, commits } = setUp();
      storing(objects);
      commits.commit.mockResolvedValue({ ok: true, stored: [file('id-1', 'a')], replaced: [] });
      await place.upload('a', Readable.from(['x']), 1, 'text/plain', { replace: true, expiresAt: '2026-12-01T00:00:00.000Z' });
      await place.upload('b', Readable.from(['x']), 1, 'text/plain', { replace: true, expiresAt: '' });
      await place.upload('c', Readable.from(['x']), 1, 'text/plain', { replace: true, expiresAt: undefined });
      expect(store.beginStoredFile.mock.calls[0]![0].expiresAt).toBe('2026-12-01T00:00:00.000Z');
      expect(store.beginStoredFile.mock.calls[1]![0]).not.toHaveProperty('expiresAt');
      expect(store.beginStoredFile.mock.calls[2]![0]).not.toHaveProperty('expiresAt');
    });

    it('replaces a file there when replacing is allowed', async () => {
      const { folder: place, objects, commits } = setUp([file('old', 'a')]);
      storing(objects);
      commits.commit.mockResolvedValue({ ok: true, stored: [file('id-1', 'a', { version: 2 })], replaced: ['old'] });
      expect(await place.upload('a', Readable.from(['x']), 1, 'text/plain', { replace: true })).toEqual({ ok: true, value: file('id-1', 'a', { version: 2 }) });
    });

    it('refuses a bad path, a folder in the way and a file it may not replace before touching storage', async () => {
      const { folder: place, store, objects, commits } = setUp([file('old', 'a'), file('x', 'dir/x')]);
      const body = (): Readable => Readable.from(['x']);
      expect(await place.upload('', body(), 1, 'text/plain', { replace: true })).toEqual({ ok: false, status: 400, why: 'a file needs a name' });
      expect(await place.upload('dir', body(), 1, 'text/plain', { replace: true })).toEqual({ ok: false, status: 409, why: 'dir is a folder' });
      expect(await place.upload('a/b', body(), 1, 'text/plain', { replace: true })).toEqual({ ok: false, status: 409, why: 'a is a file, not a folder' });
      expect(await place.upload('a', body(), 1, 'text/plain', { replace: false })).toEqual({ ok: false, status: 409, why: 'a is already there, and it may not be replaced' });
      expect(store.beginStoredFile).not.toHaveBeenCalled();
      expect(objects.put).not.toHaveBeenCalled();
      expect(commits.commit).not.toHaveBeenCalled();
    });

    it('lets a new file in without replacing when only a folder of another name is there', async () => {
      const { folder: place, objects, commits } = setUp([folder('d', 'other')]);
      storing(objects);
      commits.commit.mockResolvedValue({ ok: true, stored: [file('id-1', 'a')], replaced: [] });
      expect((await place.upload('a', Readable.from(['x']), 1, 'text/plain', { replace: false })).ok).toBe(true);
    });

    it('fails when the bytes are not there after they were sent, committing nothing', async () => {
      const { folder: place, objects, commits } = setUp();
      objects.put.mockImplementation(async (_id, body) => { await drained(body); });
      objects.stat.mockResolvedValue(undefined);
      await expect(place.upload('a/b.txt', Readable.from(['x']), 1, 'text/plain', { replace: true }))
        .rejects.toThrow('the bytes of a/b.txt were sent to the instance\'s MinIO and are not there');
      expect(commits.commit).not.toHaveBeenCalled();
    });

    it('hands back the commit\'s refusal', async () => {
      const { folder: place, objects, commits } = setUp();
      storing(objects);
      commits.commit.mockResolvedValue({ ok: false, status: 409, why: 'a is uploaded twice at once' });
      expect(await place.upload('a', Readable.from(['x']), 1, 'text/plain', { replace: true })).toEqual({ ok: false, status: 409, why: 'a is uploaded twice at once' });
    });

    it('touches the upload only once the touch interval has passed since the last touch', async () => {
      const clock = { now: T0 };
      const { folder: place, store, objects, commits } = setUp([], clock);
      const input = new PassThrough();
      let forwarded = '';
      const chunkSeen: Array<() => void> = [];
      objects.put.mockImplementation(async (_id, body) => {
        for await (const chunk of body) {
          forwarded += String(chunk);
          chunkSeen.shift()?.();
        }
      });
      objects.stat.mockResolvedValue({ size: 4 });
      commits.commit.mockResolvedValue({ ok: true, stored: [file('id-1', 'a')], replaced: [] });
      store.touchStoredFile.mockResolvedValue(undefined);
      const write = async (text: string, at: number): Promise<void> => {
        clock.now = at;
        const seen = new Promise<void>((done) => chunkSeen.push(done));
        input.write(text);
        await seen;
      };
      const done = place.upload('a', input, 4, 'text/plain', { replace: true });
      await new Promise((resolve) => setImmediate(resolve));
      await write('1', T0 + TOUCH_EVERY_MS - 1);
      expect(store.touchStoredFile).not.toHaveBeenCalled();
      await write('2', T0 + TOUCH_EVERY_MS);
      expect(store.touchStoredFile).toHaveBeenCalledTimes(1);
      expect(store.touchStoredFile).toHaveBeenLastCalledWith('id-1', new Date(T0 + TOUCH_EVERY_MS).toISOString());
      await write('3', T0 + 2 * TOUCH_EVERY_MS - 1);
      expect(store.touchStoredFile).toHaveBeenCalledTimes(1);
      await write('4', T0 + 2 * TOUCH_EVERY_MS);
      expect(store.touchStoredFile).toHaveBeenCalledTimes(2);
      expect(store.touchStoredFile).toHaveBeenLastCalledWith('id-1', new Date(T0 + 2 * TOUCH_EVERY_MS).toISOString());
      input.end();
      expect((await done).ok).toBe(true);
      expect(forwarded).toBe('1234');
    });

    it('fails the stream, and so the upload, when a touch fails', async () => {
      const clock = { now: T0 };
      const { folder: place, store, objects, commits } = setUp([], clock);
      objects.put.mockImplementation(async (_id, body) => {
        clock.now = T0 + TOUCH_EVERY_MS;
        await drained(body);
      });
      store.touchStoredFile.mockRejectedValue(new Error('the record is gone'));
      await expect(place.upload('a', Readable.from([Buffer.from('x')]), 1, 'text/plain', { replace: true })).rejects.toThrow('the record is gone');
      expect(commits.commit).not.toHaveBeenCalled();
    });
  });

  describe('making a folder', () => {
    it('makes a stored folder record with a new id and the time now', async () => {
      const { folder: place, store } = setUp();
      store.makeStoredFolder.mockResolvedValue({ ok: true, made: true });
      expect(await place.makeFolder('/a/b/')).toEqual({ ok: true, value: { path: 'a/b', made: true } });
      expect(store.makeStoredFolder).toHaveBeenCalledWith({
        id: 'id-1', ownerId: 'u1', scope: PROJECT, path: 'a/b', kind: 'folder', size: 0, contentType: 'inode/directory',
        version: 1, madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT,
      });
    });

    it('says when the folder was already there', async () => {
      const { folder: place, store } = setUp();
      store.makeStoredFolder.mockResolvedValue({ ok: true, made: false });
      expect(await place.makeFolder('a')).toEqual({ ok: true, value: { path: 'a', made: false } });
    });

    it('hands back the store\'s refusal', async () => {
      const { folder: place, store } = setUp();
      store.makeStoredFolder.mockResolvedValue({ ok: false, status: 409, why: 'a is a file' });
      expect(await place.makeFolder('a')).toEqual({ ok: false, status: 409, why: 'a is a file' });
    });

    it('refuses a path that is not one without asking the store', async () => {
      const { folder: place, store } = setUp();
      expect(await place.makeFolder('a/../../b')).toEqual({ ok: false, status: 400, why: 'a/../../b would leave the project\'s files' });
      expect(store.makeStoredFolder).not.toHaveBeenCalled();
    });
  });

  describe('moving within the place', () => {
    it('moves through the store at the time now and names the cleaned target', async () => {
      const { folder: place, store } = setUp();
      store.moveStoredFiles.mockResolvedValue({ ok: true, moved: 3 });
      expect(await place.move('a', '/b/c/')).toEqual({ ok: true, value: { path: 'b/c', moved: 3 } });
      expect(store.moveStoredFiles).toHaveBeenCalledWith('u1', PROJECT, 'a', '/b/c/', AT);
    });

    it('hands back the store\'s refusal', async () => {
      const { folder: place, store } = setUp();
      store.moveStoredFiles.mockResolvedValue({ ok: false, status: 404, why: 'a is not there' });
      expect(await place.move('a', 'b')).toEqual({ ok: false, status: 404, why: 'a is not there' });
    });

    it('names the target as given when it cannot be cleaned', async () => {
      const { folder: place, store } = setUp();
      store.moveStoredFiles.mockResolvedValue({ ok: true, moved: 0 });
      expect(await place.move('a', '')).toEqual({ ok: true, value: { path: '', moved: 0 } });
    });
  });

  describe('removing', () => {
    it('removes a folder with everything under it, never a sibling sharing its start', async () => {
      const { folder: place, commits } = setUp([folder('d', 'a'), file('1', 'a/x'), file('2', 'a/b/y'), file('3', 'ab')]);
      expect(await place.remove('/a/')).toEqual({ ok: true, value: { path: 'a', removed: 3 } });
      expect(commits.remove).toHaveBeenCalledWith('u1', ['d', '1', '2']);
    });

    it('removes one file', async () => {
      const { folder: place, commits } = setUp([file('1', 'a'), file('2', 'b')]);
      expect(await place.remove('b')).toEqual({ ok: true, value: { path: 'b', removed: 1 } });
      expect(commits.remove).toHaveBeenCalledWith('u1', ['2']);
    });

    it('refuses a bad path and one nothing is at, removing nothing', async () => {
      const { folder: place, commits } = setUp([file('1', 'a')]);
      expect(await place.remove('')).toEqual({ ok: false, status: 400, why: 'a file needs a name' });
      expect(await place.remove('z')).toEqual({ ok: false, status: 404, why: 'z is not here' });
      expect(commits.remove).not.toHaveBeenCalled();
    });

    it('removes everything in the place and says how much', async () => {
      const { folder: place, commits } = setUp([file('1', 'a'), folder('2', 'b')]);
      expect(await place.removeAll()).toBe(2);
      expect(commits.remove).toHaveBeenCalledWith('u1', ['1', '2']);
    });

    it('asks nothing to be removed when the place is empty', async () => {
      const { folder: place, commits } = setUp([]);
      expect(await place.removeAll()).toBe(0);
      expect(commits.remove).not.toHaveBeenCalled();
    });
  });
});
