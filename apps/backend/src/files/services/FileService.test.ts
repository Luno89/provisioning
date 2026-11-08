import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { anyObject, mock } from 'vitest-mock-extended';
import type { FileShare } from '../lib/file-shares.js';
import type { StoredFileRecord } from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';
import { FileService, type FileServiceDeps } from './FileService.js';
import { receiveStoredDrop } from './stored-drop.js';
import type { Folder, UploadBatch } from './StoredFiles.js';

vi.mock('./stored-drop.js', () => ({ receiveStoredDrop: vi.fn() }));
const received = vi.mocked(receiveStoredDrop);

const AT = '2026-10-21T10:00:00.000Z';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';

const record = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, objectId: id, ownerId: 'u1', scope: { kind: 'project', id: 'p1' }, path, kind: 'file', size: 4, contentType: 'application/pdf', version: 1,
  madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT, ...extra,
});

const share = (extra: Partial<FileShare> = {}): FileShare => ({ id: 's1', token: TOKEN, ownerId: 'u1', fileId: 'f1', path: 'a.pdf', name: 'a.pdf', createdAt: AT, expiresAt: '2026-10-28T10:00:00.000Z', ...extra });

const setUp = () => {
  const folder = mock<Folder>();
  const files = mock<FileServiceDeps['files']>();
  const shares = mock<Pick<FilesStore, 'getFileShares' | 'getFileShare' | 'getFileShareByToken' | 'saveFileShare' | 'deleteFileShare'>>();
  files.at.mockReturnValue(folder);
  const clock = { now: AT };
  return { folder, files, shares, clock, service: new FileService({ files, shares, now: () => clock.now }) };
};

const project = { kind: 'project' as const, project: { id: 'p1' } };
const channel = { kind: 'conversation' as const, conversationId: 'channel-p1', projectId: 'p1' };

describe('the file service', () => {
  it('opens the stored place of each scope', async () => {
    const { files, folder, service } = setUp();
    folder.list.mockResolvedValue({ ok: true, value: [] });
    await service.list('u1', project, '');
    await service.list('u1', { kind: 'person' }, '');
    await service.list('u1', { kind: 'conversation', conversationId: 'c1' }, '');
    await service.list('u1', channel, '');
    expect(files.at.mock.calls).toEqual([
      ['u1', { kind: 'project', id: 'p1' }],
      ['u1', { kind: 'person', id: 'u1' }],
      ['u1', { kind: 'conversation', id: 'c1' }],
      ['u1', { kind: 'project', id: 'p1' }],
    ]);
  });

  it('works a project chat\'s files under the chat\'s folder and hands back paths inside it', async () => {
    const { folder, service } = setUp();
    folder.list.calledWith('chats/channel-p1/docs').mockResolvedValue({ ok: true, value: [{ name: 'a.png', path: 'chats/channel-p1/docs/a.png', type: 'file' }] });
    folder.search.calledWith('a').mockResolvedValue([{ name: 'a.png', path: 'chats/channel-p1/docs/a.png', type: 'file' }, { name: 'a.txt', path: 'a.txt', type: 'file' }]);
    folder.upload.calledWith('chats/channel-p1/b.png', anyObject(), 1, 'image/png', anyObject()).mockResolvedValue({ ok: true, value: record('f2', 'chats/channel-p1/b.png') });
    folder.move.calledWith('chats/channel-p1/b.png', 'chats/channel-p1/old/b.png').mockResolvedValue({ ok: true, value: { path: 'chats/channel-p1/old/b.png', moved: 1 } });
    folder.remove.calledWith('chats/channel-p1/old').mockResolvedValue({ ok: true, value: { path: 'chats/channel-p1/old', removed: 1 } });
    folder.makeFolder.calledWith('chats/channel-p1/new').mockResolvedValue({ ok: true, value: { path: 'chats/channel-p1/new', made: true } });
    expect(await service.list('u1', channel, 'docs')).toEqual({ ok: true, value: [{ name: 'a.png', path: 'docs/a.png', type: 'file' }] });
    expect(await service.search('u1', channel, 'a')).toEqual({ ok: true, value: [{ name: 'a.png', path: 'docs/a.png', type: 'file' }] });
    expect(await service.upload('u1', channel, 'b.png', Readable.from([Buffer.from('b')]), 1, 'image/png', { replace: false })).toEqual({ ok: true, value: { path: 'b.png', id: 'f2' } });
    expect(await service.move('u1', channel, 'b.png', 'old/b.png')).toEqual({ ok: true, value: { path: 'old/b.png' } });
    expect(await service.remove('u1', channel, 'old')).toEqual({ ok: true, value: { path: 'old' } });
    expect(await service.makeFolder('u1', channel, 'new')).toEqual({ ok: true, value: { path: 'new' } });
  });

  it('lists a chat\'s folder that holds nothing yet as empty, and refuses any other folder that is not there', async () => {
    const { folder, service } = setUp();
    folder.list.mockResolvedValue({ ok: false, status: 404, why: 'not a folder here' });
    expect(await service.list('u1', channel, '')).toEqual({ ok: true, value: [] });
    expect(await service.list('u1', channel, 'docs')).toEqual({ ok: false, status: 404, why: 'not a folder here' });
    expect(await service.list('u1', project, '')).toEqual({ ok: false, status: 404, why: 'not a folder here' });
  });

  it('uploads with the replace choice it is given, and passes on a refusal', async () => {
    const { folder, service } = setUp();
    folder.upload.mockResolvedValueOnce({ ok: false, status: 409, why: 'a.pdf is a folder' });
    expect(await service.upload('u1', project, 'a.pdf', Readable.from([]), 0, 'application/pdf', { replace: true })).toEqual({ ok: false, status: 409, why: 'a.pdf is a folder' });
    expect(folder.upload).toHaveBeenCalledWith('a.pdf', anyObject(), 0, 'application/pdf', { replace: true });
    folder.upload.mockResolvedValueOnce({ ok: false, status: 507, why: 'This needs 2 bytes, and 1 bytes is free', needed: 2, free: 1 });
    expect(await service.upload('u1', project, 'a.pdf', Readable.from([]), 2, 'application/pdf', { replace: false })).toEqual({ ok: false, status: 507, why: 'This needs 2 bytes, and 1 bytes is free', needed: 2, free: 1 });
    expect(folder.upload).toHaveBeenLastCalledWith('a.pdf', anyObject(), 2, 'application/pdf', { replace: false });
  });

  it('says a file is already there by the path the person sees, when it may not be replaced', async () => {
    const { folder, service } = setUp();
    folder.upload.mockResolvedValueOnce({ ok: false, status: 409, why: 'chats/channel-p1/a.pdf is already there', exists: ['chats/channel-p1/a.pdf'] });
    expect(await service.upload('u1', channel, 'a.pdf', Readable.from([]), 0, 'application/pdf', { replace: false })).toEqual({ ok: false, status: 409, why: 'a.pdf is already there', exists: true });
  });

  it('says how much room is left where files are kept', async () => {
    const { files, service } = setUp();
    files.room.mockResolvedValue(4096);
    expect(await service.room()).toEqual({ free: 4096 });
  });

  it('refuses a drop larger than the room left before reading any of it', async () => {
    const { files, service } = setUp();
    files.room.mockResolvedValue(10);
    received.mockClear();
    expect(await service.drop('u1', project, Readable.from([]), 11)).toEqual({ ok: false, status: 507, why: 'This needs 11 bytes, and 10 bytes is free', needed: 11, free: 10 });
    expect(received).not.toHaveBeenCalled();
  });

  it('keeps a drop in the scope\'s place, opening batches there and answering each file\'s path and id as the person sees it', async () => {
    const { files, folder, service } = setUp();
    files.room.mockResolvedValue(10);
    const batch = mock<UploadBatch>();
    folder.startBatch.calledWith(anyObject()).mockResolvedValue(batch);
    const body = Readable.from([]);
    received.mockImplementationOnce(async (_body, open, placed) => {
      expect(await open(true)).toBe(batch);
      expect(placed('docs/a.png')).toBe('chats/channel-p1/docs/a.png');
      return { ok: true, value: [record('f1', 'chats/channel-p1/docs/a.png'), record('f2', 'chats/channel-p1/b.png')] };
    });
    expect(await service.drop('u1', channel, body, 10)).toEqual({ ok: true, value: { files: [{ path: 'docs/a.png', id: 'f1' }, { path: 'b.png', id: 'f2' }] } });
    expect(received.mock.lastCall?.[0]).toBe(body);
    expect(folder.startBatch).toHaveBeenCalledWith({ replace: true });
  });

  it('names every file of a drop that is already there by the path the person sees, and passes on any other refusal', async () => {
    const { files, service } = setUp();
    files.room.mockResolvedValue(10);
    received.mockResolvedValueOnce({ ok: false, status: 409, why: '2 files are already there', exists: ['chats/channel-p1/a.png', 'chats/channel-p1/b/c.png'] });
    expect(await service.drop('u1', channel, Readable.from([]), undefined)).toEqual({ ok: false, status: 409, why: '2 files are already there: a.png, b/c.png', exists: ['a.png', 'b/c.png'] });
    received.mockResolvedValueOnce({ ok: false, status: 400, why: 'nothing was dropped' });
    expect(await service.drop('u1', channel, Readable.from([]), undefined)).toEqual({ ok: false, status: 400, why: 'nothing was dropped' });
  });

  it('downloads by path with the record\'s size and type, and names a missing file', async () => {
    const { folder, service } = setUp();
    const stream = Readable.from([Buffer.from('%PDF')]);
    folder.download.calledWith('a.pdf').mockResolvedValue({ ok: true, value: { record: record('f1', 'a.pdf'), body: stream } });
    folder.download.calledWith('b.pdf').mockResolvedValue({ ok: false, status: 404, why: 'b.pdf is not here' });
    folder.download.calledWith('..').mockResolvedValue({ ok: false, status: 400, why: 'bad' });
    expect(await service.download('u1', project, 'a.pdf')).toEqual({ ok: true, value: { stream, size: 4, contentType: 'application/pdf' } });
    expect(await service.download('u1', project, 'b.pdf')).toEqual({ ok: false, status: 404, why: 'There is no file b.pdf.' });
    expect(await service.download('u1', project, '..')).toEqual({ ok: false, status: 400, why: 'bad' });
  });

  it('hands over a file by its id only when it is kept in the scope asked about', async () => {
    const { files, service } = setUp();
    const stream = Readable.from([Buffer.from('%PDF')]);
    files.recordById.calledWith('u1', 'f1').mockResolvedValue(record('f1', 'chats/channel-p1/a.pdf'));
    files.recordById.calledWith('u1', 'f2').mockResolvedValue(record('f2', 'b.pdf', { scope: { kind: 'conversation', id: 'c1' } }));
    files.recordById.calledWith('u1', 'd').mockResolvedValue(record('d', 'chats/channel-p1/docs', { kind: 'folder' }));
    files.byId.calledWith('u1', 'f1').mockResolvedValue({ record: record('f1', 'chats/channel-p1/a.pdf'), body: stream });
    expect(await service.downloadIn('u1', channel, 'f1')).toEqual({ ok: true, value: { stream, size: 4, contentType: 'application/pdf', path: 'a.pdf' } });
    expect(await service.downloadIn('u1', project, 'f1')).toMatchObject({ ok: true, value: { path: 'chats/channel-p1/a.pdf' } });
    expect(await service.downloadIn('u1', { kind: 'conversation', conversationId: 'other', projectId: 'p1' }, 'f1')).toEqual({ ok: false, status: 404, why: 'There is no file f1 here.' });
    expect(await service.downloadIn('u1', project, 'f2')).toEqual({ ok: false, status: 404, why: 'There is no file f2 here.' });
    expect(await service.downloadIn('u1', channel, 'd')).toEqual({ ok: false, status: 404, why: 'There is no file d here.' });
    expect(await service.downloadIn('u1', channel, 'none')).toEqual({ ok: false, status: 404, why: 'There is no file none here.' });
  });

  it('describes a file to attach by its id, with its project when it is kept in one, and never a folder', async () => {
    const { files, service } = setUp();
    files.recordById.calledWith('u1', 'f1').mockResolvedValue(record('f1', 'chats/c/a.pdf'));
    files.recordById.calledWith('u1', 'f2').mockResolvedValue(record('f2', 'b.pdf', { scope: { kind: 'conversation', id: 'c1' } }));
    files.recordById.calledWith('u1', 'd').mockResolvedValue(record('d', 'docs', { kind: 'folder' }));
    files.recordById.calledWith('u1', 'none').mockResolvedValue(undefined);
    expect(await service.attachable('u1', 'f1')).toEqual({ id: 'f1', path: 'chats/c/a.pdf', size: 4, contentType: 'application/pdf', projectId: 'p1' });
    expect(await service.attachable('u1', 'f2')).toEqual({ id: 'f2', path: 'b.pdf', size: 4, contentType: 'application/pdf' });
    expect(await service.attachable('u1', 'd')).toBeUndefined();
    expect(await service.attachable('u1', 'none')).toBeUndefined();
  });

  it('shares the file found at the path by its id, in the project when it is kept in one', async () => {
    const { folder, shares, service } = setUp();
    folder.find.calledWith('chats/channel-p1/a.pdf').mockResolvedValue(record('f1', 'chats/channel-p1/a.pdf'));
    folder.find.calledWith('chats/channel-p1/no.pdf').mockResolvedValue(undefined);
    const made = await service.share('u1', channel, 'a.pdf', 7);
    expect(made).toMatchObject({ ok: true, value: { ownerId: 'u1', projectId: 'p1', fileId: 'f1', path: 'a.pdf', name: 'a.pdf', createdAt: AT, expiresAt: '2026-10-28T10:00:00.000Z' } });
    expect(shares.saveFileShare).toHaveBeenCalledWith(made.ok ? made.value : undefined);
    expect(await service.share('u1', channel, 'no.pdf', 7)).toEqual({ ok: false, status: 404, why: 'There is no file no.pdf.' });
  });

  it('serves a link\'s file by its id, forgets an expired link, and opens nothing for a link to no file', async () => {
    const { files, shares, clock, service } = setUp();
    const stream = Readable.from([Buffer.from('%PDF')]);
    shares.getFileShareByToken.calledWith(TOKEN).mockResolvedValue(share());
    files.byId.calledWith('u1', 'f1').mockResolvedValue({ record: record('f1', 'docs/renamed.pdf'), body: stream });
    expect(await service.shared(TOKEN)).toEqual({ ok: true, value: { stream, size: 4, contentType: 'application/pdf', name: 'a.pdf' } });
    files.byId.calledWith('u1', 'f1').mockResolvedValue(undefined);
    expect(await service.shared(TOKEN)).toEqual({ ok: false, status: 404, why: 'The file this link was made for has been removed, so the link opens nothing.' });
    shares.getFileShareByToken.calledWith(TOKEN).mockResolvedValue(share({ fileId: undefined }));
    expect(await service.shared(TOKEN)).toEqual({ ok: false, status: 404, why: 'This link was made for a file Koala no longer keeps, so it opens nothing.' });
    clock.now = '2026-10-28T10:00:00.000Z';
    shares.getFileShareByToken.calledWith(TOKEN).mockResolvedValue(share());
    expect(await service.shared(TOKEN)).toMatchObject({ ok: false, status: 404 });
    expect(shares.deleteFileShare).toHaveBeenCalledWith('s1');
    expect(await service.shared('not a token')).toMatchObject({ ok: false, status: 404 });
  });

  it('lists only live links and revokes only the person\'s own', async () => {
    const { shares, clock, service } = setUp();
    shares.getFileShares.calledWith('u1').mockResolvedValue([share(), share({ id: 's2', expiresAt: AT })]);
    shares.getFileShare.calledWith('s1').mockResolvedValue(share());
    expect((await service.shares('u1')).map((entry) => entry.id)).toEqual(['s1']);
    expect(await service.unshare('u2', 's1')).toEqual({ ok: false, status: 404, why: 'There is no such link.' });
    expect(await service.unshare('u1', 'none')).toEqual({ ok: false, status: 404, why: 'There is no such link.' });
    expect(await service.unshare('u1', 's1')).toEqual({ ok: true, value: { id: 's1' } });
    expect(shares.deleteFileShare).toHaveBeenCalledExactlyOnceWith('s1');
    expect(clock.now).toBe(AT);
  });

  it('removes everything kept in a project', async () => {
    const { files, folder, service } = setUp();
    folder.removeAll.mockResolvedValue(3);
    expect(await service.removeProjectFiles('u1', 'p1')).toBe(3);
    expect(files.at).toHaveBeenCalledWith('u1', { kind: 'project', id: 'p1' });
  });
});
