import { describe, expect, it } from 'vitest';
import type { FileShare } from '../lib/file-shares.js';
import type { StoredFileRecord } from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const OTHER_TOKEN = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654';

const share = (id: string, token: string, extra: Partial<FileShare> = {}): FileShare => ({
  id, token, ownerId: 'u1', path: 'a.pdf', name: 'a.pdf', createdAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z', ...extra,
});

const AT = '2026-11-07T10:00:00.000Z';
const LATER = '2026-11-07T11:00:00.000Z';
const PROJECT = { kind: 'project', id: 'p1' } as const;

const upload = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, objectId: id, ownerId: 'u1', scope: { ...PROJECT }, path, kind: 'file', size: 0, contentType: 'text/plain', version: 0,
  madeAt: AT, changedAt: AT, state: 'uploading', touchedAt: AT, ...extra,
});

const folder = (id: string, path: string): StoredFileRecord => ({ ...upload(id, path), kind: 'folder', contentType: 'inode/directory', state: 'stored', version: 1 });

const kept = async (store: FilesStore, id: string, path: string, size = 1, extra: Partial<StoredFileRecord> = {}): Promise<void> => {
  await store.beginStoredFile(upload(id, path, extra));
  const done = await store.commitStoredFiles([{ id, size }], { replace: true }, AT);
  if (!done.ok) throw new Error(done.why);
};

const paths = async (store: FilesStore, scope: StoredFileRecord['scope'] = PROJECT): Promise<string[]> => (await store.storedFilesIn('u1', scope)).map((record) => record.path).sort();

export function filesStoreContract(make: () => Promise<FilesStore>): void {
  describe('the records of stored files', () => {
    it('keeps an upload out of sight until it is committed, then shows it stored with its size and first version', async () => {
      const store = await make();
      await store.beginStoredFile(upload('f1', 'notes/a.txt'));
      expect(await store.storedFilesIn('u1', PROJECT)).toEqual([]);
      expect((await store.storedFileById('f1'))?.state).toBe('uploading');
      const done = await store.commitStoredFiles([{ id: 'f1', size: 12 }], { replace: false }, LATER);
      expect(done).toMatchObject({ ok: true, replaced: [] });
      expect(await store.storedFilesIn('u1', PROJECT)).toEqual([{ ...upload('f1', 'notes/a.txt'), state: 'stored', size: 12, version: 1, changedAt: LATER, touchedAt: LATER }]);
    });

    it('keeps a file one record across versions: a new upload at its path gives it new bytes and the next version, keeps its id and when it was first made, and the upload\'s record goes', async () => {
      const store = await make();
      await kept(store, 'old', 'a.txt');
      await store.beginStoredFile(upload('new', 'a.txt', { madeAt: LATER, contentType: 'text/markdown' }));
      expect(await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: true }, LATER)).toMatchObject({ ok: true, replaced: ['old'], absorbed: ['new'] });
      const records = await store.storedFilesIn('u1', PROJECT);
      expect(records.map((record) => [record.id, record.objectId, record.version, record.madeAt, record.changedAt, record.size, record.contentType])).toEqual([['old', 'new', 2, AT, LATER, 5, 'text/markdown']]);
      expect(await store.storedFileById('new')).toBeUndefined();
      expect((await store.storedFileByObject('new'))?.id).toBe('old');
      expect(await store.storedFileByObject('old')).toBeUndefined();
    });

    it('takes a commit retried after it replaced a file as done, and changes nothing', async () => {
      const store = await make();
      await kept(store, 'old', 'a.txt');
      await store.beginStoredFile(upload('new', 'a.txt'));
      const first = await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: true }, LATER);
      const before = await store.storedFilesIn('u1', PROJECT);
      const again = await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: true }, '2026-11-07T12:00:00.000Z');
      expect(again).toMatchObject({ ok: true, replaced: [], absorbed: [] });
      expect(again.ok && again.stored).toEqual(first.ok && first.stored);
      expect(await store.storedFilesIn('u1', PROJECT)).toEqual(before);
    });

    it('leaves a file\'s share links on it through a new version, since the file keeps its id', async () => {
      const store = await make();
      await kept(store, 'old', 'a.txt');
      await kept(store, 'b', 'b.txt');
      await store.saveFileShare({ id: 's1', token: TOKEN, ownerId: 'u1', fileId: 'old', path: 'a.txt', name: 'a.txt', createdAt: AT, expiresAt: LATER });
      await store.saveFileShare({ id: 's2', token: OTHER_TOKEN, ownerId: 'u1', fileId: 'b', path: 'b.txt', name: 'b.txt', createdAt: AT, expiresAt: LATER });
      await store.beginStoredFile(upload('new', 'a.txt'));
      expect(await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: true }, LATER)).toMatchObject({ ok: true });
      expect((await store.getFileShare('s1'))?.fileId).toBe('old');
      expect((await store.getFileShare('s2'))?.fileId).toBe('b');
    });

    it('refuses to replace a file when told it may not, and changes nothing', async () => {
      const store = await make();
      await kept(store, 'old', 'a.txt');
      await store.beginStoredFile(upload('new', 'a.txt'));
      expect(await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: false }, LATER)).toMatchObject({ ok: false, status: 409 });
      expect((await store.storedFilesIn('u1', PROJECT)).map((record) => record.id)).toEqual(['old']);
      expect((await store.storedFileById('new'))?.state).toBe('uploading');
    });

    it('commits a drop of several files all together, or none of them when one cannot be', async () => {
      const store = await make();
      await kept(store, 'there', 'taken.txt');
      await store.beginStoredFile(upload('a', 'a.txt'));
      await store.beginStoredFile(upload('b', 'taken.txt'));
      expect(await store.commitStoredFiles([{ id: 'a', size: 1 }, { id: 'b', size: 1 }], { replace: false }, LATER)).toMatchObject({ ok: false, status: 409 });
      expect(await paths(store)).toEqual(['taken.txt']);
      expect(await store.commitStoredFiles([{ id: 'a', size: 1 }, { id: 'b', size: 2 }], { replace: true }, LATER)).toMatchObject({ ok: true, replaced: ['there'] });
      expect(await paths(store)).toEqual(['a.txt', 'taken.txt']);
    });

    it('takes committing a kept file again as done, and refuses an upload it does not hold, the same path twice at once, or a file where a folder is', async () => {
      const store = await make();
      expect(await store.commitStoredFiles([{ id: 'never', size: 1 }], { replace: true }, AT)).toMatchObject({ ok: false, status: 404 });
      await kept(store, 'done', 'done.txt', 7);
      expect(await store.commitStoredFiles([{ id: 'done', size: 99 }], { replace: false }, LATER)).toMatchObject({ ok: true, replaced: [] });
      expect((await store.storedFileById('done'))).toMatchObject({ size: 7, version: 1, changedAt: AT });
      await store.beginStoredFile(upload('x', 'same.txt'));
      await store.beginStoredFile(upload('y', 'same.txt'));
      expect(await store.commitStoredFiles([{ id: 'x', size: 1 }, { id: 'y', size: 1 }], { replace: true }, AT)).toMatchObject({ ok: false, status: 409 });
      await store.makeStoredFolder(folder('dir', 'docs'));
      await store.beginStoredFile(upload('z', 'docs'));
      expect(await store.commitStoredFiles([{ id: 'z', size: 1 }], { replace: true }, AT)).toMatchObject({ ok: false, status: 409 });
    });

    it('keeps each place apart: the same path in another scope or for another person is another file', async () => {
      const store = await make();
      await kept(store, 'p', 'a.txt');
      await kept(store, 'q', 'a.txt', 1, { scope: { kind: 'person', id: 'u1' } });
      await kept(store, 'r', 'a.txt', 1, { ownerId: 'u2' });
      expect(await paths(store)).toEqual(['a.txt']);
      expect(await paths(store, { kind: 'person', id: 'u1' })).toEqual(['a.txt']);
      expect((await store.storedFilesIn('u2', PROJECT)).map((record) => record.id)).toEqual(['r']);
    });

    it('makes a folder once, says when it was already there, and refuses one where a file is', async () => {
      const store = await make();
      expect(await store.makeStoredFolder(folder('d1', 'docs'))).toEqual({ ok: true, made: true });
      expect(await store.makeStoredFolder(folder('d2', 'docs'))).toEqual({ ok: true, made: false });
      await kept(store, 'f', 'a.txt');
      expect(await store.makeStoredFolder(folder('d3', 'a.txt/inner'))).toMatchObject({ ok: false, status: 409 });
      expect(await paths(store)).toEqual(['a.txt', 'docs']);
    });

    it('moves a folder with everything under it, drops the share links of what moved, and leaves the rest', async () => {
      const store = await make();
      await kept(store, 'a', 'docs/a.txt');
      await kept(store, 'b', 'docs/deep/b.txt');
      await kept(store, 'c', 'docsish.txt');
      await store.saveFileShare({ id: 's1', token: 'abcdefghijklmnopqrstuvwxyz012345', ownerId: 'u1', fileId: 'a', path: 'docs/a.txt', name: 'a.txt', createdAt: AT, expiresAt: LATER });
      await store.saveFileShare({ id: 's2', token: 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654', ownerId: 'u1', fileId: 'c', path: 'docsish.txt', name: 'docsish.txt', createdAt: AT, expiresAt: LATER });
      expect(await store.moveStoredFiles('u1', PROJECT, 'docs', 'archive/docs', LATER)).toEqual({ ok: true, moved: 2 });
      expect(await paths(store)).toEqual(['archive/docs/a.txt', 'archive/docs/deep/b.txt', 'docsish.txt']);
      expect((await store.getFileShares('u1')).map((share) => share.id)).toEqual(['s2']);
    });

    it('refuses a move onto something already there and moves nothing', async () => {
      const store = await make();
      await kept(store, 'a', 'a.txt');
      await kept(store, 'b', 'b.txt');
      expect(await store.moveStoredFiles('u1', PROJECT, 'a.txt', 'b.txt', LATER)).toMatchObject({ ok: false, status: 409 });
      expect(await store.moveStoredFiles('u1', PROJECT, 'gone.txt', 'c.txt', LATER)).toMatchObject({ ok: false, status: 404 });
      expect(await paths(store)).toEqual(['a.txt', 'b.txt']);
    });

    it('moves a whole scope under a folder of another, dropping the moved files\' share links', async () => {
      const store = await make();
      const chat = { kind: 'conversation', id: 'c9' } as const;
      await kept(store, 'a', 'a.png', 1, { scope: { ...chat } });
      await kept(store, 'b', 'x/b.png', 1, { scope: { ...chat } });
      await store.saveFileShare({ id: 's1', token: 'abcdefghijklmnopqrstuvwxyz012345', ownerId: 'u1', fileId: 'a', path: 'a.png', name: 'a.png', createdAt: AT, expiresAt: LATER });
      expect(await store.moveStoredScope('u1', chat, PROJECT, 'chats/c9', LATER)).toBe(2);
      expect(await paths(store, chat)).toEqual([]);
      expect(await paths(store)).toEqual(['chats/c9/a.png', 'chats/c9/x/b.png']);
      expect(await store.getFileShares('u1')).toEqual([]);
    });

    it('deletes records with their share links, says which bytes its records still name, and finds dead uploads and expired files', async () => {
      const store = await make();
      await kept(store, 'a', 'a.txt');
      await kept(store, 'run', 'out.png', 1, { scope: { kind: 'run', id: 'r1' }, expiresAt: AT });
      await store.beginStoredFile(upload('stale', 'stale.txt', { touchedAt: AT }));
      await store.beginStoredFile(upload('live', 'live.txt', { touchedAt: LATER }));
      await store.touchStoredFile('a', LATER);
      expect((await store.deadStoredUploads(AT)).map((record) => record.id)).toEqual(['stale']);
      expect((await store.expiredStoredFiles(AT)).map((record) => record.id)).toEqual(['run']);
      expect((await store.storedObjectIdsAmong(['a', 'nope', 'live'])).sort()).toEqual(['a', 'live']);
      await store.saveFileShare({ id: 's1', token: 'abcdefghijklmnopqrstuvwxyz012345', ownerId: 'u1', fileId: 'a', path: 'a.txt', name: 'a.txt', createdAt: AT, expiresAt: LATER });
      await store.deleteStoredFiles(['a', 'stale']);
      await store.deleteStoredFiles([]);
      expect(await store.storedObjectIdsAmong(['a', 'stale', 'live'])).toEqual(['live']);
      await store.commitStoredFiles([{ id: 'live', size: 1 }], { replace: true }, LATER);
      await kept(store, 'next', 'live.txt');
      expect((await store.storedObjectIdsAmong(['live', 'next'])).sort()).toEqual(['next']);
      expect(await store.getFileShares('u1')).toEqual([]);
      expect((await store.storedFileById('run'))?.changedAt).toBe(AT);
    });
  });

  describe('whose stored files they are', () => {
    it('lists everything a person keeps, in every scope and state, and nothing of anyone else', async () => {
      const store = await make();
      await kept(store, 'a', 'a.txt');
      await kept(store, 'mine', 'b.txt', 1, { scope: { kind: 'person', id: 'u1' } });
      await kept(store, 'out', 'out.png', 1, { scope: { kind: 'run', id: 'r1' } });
      await store.beginStoredFile(upload('half', 'half.txt'));
      await kept(store, 'theirs', 'c.txt', 1, { ownerId: 'u2' });
      expect((await store.storedFilesOwnedBy('u1')).map((record) => record.id).sort()).toEqual(['a', 'half', 'mine', 'out']);
      expect((await store.storedFilesOwnedBy('u2')).map((record) => record.id)).toEqual(['theirs']);
      expect(await store.storedFilesOwnedBy('nobody')).toEqual([]);
    });

    it('hands the files of the named runs to another person, and nothing else of theirs', async () => {
      const store = await make();
      await kept(store, 'r1', 'shot.png', 1, { ownerId: 'space', scope: { kind: 'run', id: 'run-1' } });
      await kept(store, 'r2', 'shot.png', 1, { ownerId: 'space', scope: { kind: 'run', id: 'run-2' } });
      await kept(store, 'p', 'a.txt', 1, { ownerId: 'space' });
      expect(await store.reownRunFiles('space', 'u1', [])).toBe(0);
      expect(await store.reownRunFiles('space', 'space', ['run-1'])).toBe(0);
      expect(await store.reownRunFiles('space', 'u1', ['run-1'])).toBe(1);
      expect((await store.storedFileById('r1'))?.ownerId).toBe('u1');
      expect((await store.storedFileById('r2'))?.ownerId).toBe('space');
      expect(await store.reownRunFiles('space', 'u1')).toBe(1);
      expect((await store.storedFileById('r2'))?.ownerId).toBe('u1');
      expect((await store.storedFileById('p'))?.ownerId).toBe('space');
    });
  });

  describe('share links', () => {
    it('finds a link by its id and by its token, with the token as it was saved', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN, { projectId: 'p1', fileId: 'f1' }));
      expect(await store.getFileShare('s1')).toEqual(share('s1', TOKEN, { projectId: 'p1', fileId: 'f1' }));
      expect(await store.getFileShareByToken(TOKEN)).toEqual(share('s1', TOKEN, { projectId: 'p1', fileId: 'f1' }));
    });

    it('finds nothing by an id used as a token, a token used as an id, or a link that was never saved', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN));
      expect(await store.getFileShareByToken('s1')).toBeUndefined();
      expect(await store.getFileShare(TOKEN)).toBeUndefined();
      expect(await store.getFileShare('never')).toBeUndefined();
      expect(await store.getFileShareByToken(OTHER_TOKEN)).toBeUndefined();
    });

    it('lists a person\'s links newest first and only theirs', async () => {
      const store = await make();
      await store.saveFileShare(share('old', TOKEN, { createdAt: '2026-10-25T00:00:00.000Z' }));
      await store.saveFileShare(share('new', OTHER_TOKEN, { createdAt: '2026-10-29T00:00:00.000Z' }));
      await store.saveFileShare(share('mid', 'm'.repeat(32), { createdAt: '2026-10-27T00:00:00.000Z' }));
      await store.saveFileShare(share('stranger', 's'.repeat(32), { ownerId: 'u2' }));
      expect((await store.getFileShares('u1')).map((entry) => entry.id)).toEqual(['new', 'mid', 'old']);
      expect((await store.getFileShares('u1')).map((entry) => entry.token)).toEqual([OTHER_TOKEN, 'm'.repeat(32), TOKEN]);
      expect((await store.getFileShares('u2')).map((entry) => entry.id)).toEqual(['stranger']);
      expect(await store.getFileShares('nobody')).toEqual([]);
    });

    it('replaces a link saved again under its id, and then opens by the new token only', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN, { fileId: 'f1' }));
      await store.saveFileShare(share('s1', OTHER_TOKEN));
      expect(await store.getFileShare('s1')).toEqual(share('s1', OTHER_TOKEN));
      expect(await store.getFileShareByToken(TOKEN)).toBeUndefined();
      expect(await store.getFileShareByToken(OTHER_TOKEN)).toMatchObject({ id: 's1' });
      expect(await store.getFileShares('u1')).toHaveLength(1);
    });

    it('refuses a second link under a token already taken, and keeps the first', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN));
      await expect(store.saveFileShare(share('s2', TOKEN))).rejects.toThrow();
      expect(await store.getFileShareByToken(TOKEN)).toMatchObject({ id: 's1' });
      expect(await store.getFileShare('s2')).toBeUndefined();
    });

    it('forgets a link when deleted, its token with it', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN));
      await store.deleteFileShare('s1');
      expect(await store.getFileShare('s1')).toBeUndefined();
      expect(await store.getFileShareByToken(TOKEN)).toBeUndefined();
      expect(await store.getFileShares('u1')).toEqual([]);
      await store.deleteFileShare('never');
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN));
      const read = await store.getFileShare('s1');
      read!.path = 'changed';
      (await store.getFileShares('u1'))[0]!.name = 'changed';
      expect(await store.getFileShare('s1')).toEqual(share('s1', TOKEN));
    });

    it('has no link left to seal when every one was saved through it', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN));
      expect(await store.sealShareTokens()).toBe(0);
      expect(await store.getFileShareByToken(TOKEN)).toMatchObject({ id: 's1' });
    });
  });
}
