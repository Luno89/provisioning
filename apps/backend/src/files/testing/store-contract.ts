import { describe, expect, it } from 'vitest';
import type { StoredArtifact } from '../lib/artifacts.js';
import type { FileShare } from '../lib/file-shares.js';
import type { StoredFileRecord } from '../lib/stored-files.js';
import type { FilesStore } from '../store.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const OTHER_TOKEN = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654';

const artifact = (id: string, extra: Partial<StoredArtifact> = {}): StoredArtifact => ({
  id, ownerId: 'u1', runId: 'run-1', name: `${id}.png`, contentType: 'image/png', size: 10, place: 'minio',
  createdAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-10T00:00:00.000Z', ...extra,
});

const share = (id: string, token: string, extra: Partial<FileShare> = {}): FileShare => ({
  id, token, ownerId: 'u1', path: 'a.pdf', name: 'a.pdf', createdAt: '2026-10-27T00:00:00.000Z', expiresAt: '2026-11-03T00:00:00.000Z', ...extra,
});

const AT = '2026-11-07T10:00:00.000Z';
const LATER = '2026-11-07T11:00:00.000Z';
const PROJECT = { kind: 'project', id: 'p1' } as const;

const upload = (id: string, path: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, ownerId: 'u1', scope: { ...PROJECT }, path, kind: 'file', size: 0, contentType: 'text/plain', version: 0,
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

    it('replaces a file at the same path in one step: the old record goes, the new one is its next version and keeps when it was first made', async () => {
      const store = await make();
      await kept(store, 'old', 'a.txt');
      await store.beginStoredFile(upload('new', 'a.txt', { madeAt: LATER }));
      expect(await store.commitStoredFiles([{ id: 'new', size: 5 }], { replace: true }, LATER)).toMatchObject({ ok: true, replaced: ['old'] });
      const records = await store.storedFilesIn('u1', PROJECT);
      expect(records.map((record) => [record.id, record.version, record.madeAt, record.size])).toEqual([['new', 2, AT, 5]]);
      expect(await store.storedFileById('old')).toBeUndefined();
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

    it('deletes records with their share links, says which ids it still holds, and finds dead uploads and expired files', async () => {
      const store = await make();
      await kept(store, 'a', 'a.txt');
      await kept(store, 'run', 'out.png', 1, { scope: { kind: 'run', id: 'r1' }, expiresAt: AT });
      await store.beginStoredFile(upload('stale', 'stale.txt', { touchedAt: AT }));
      await store.beginStoredFile(upload('live', 'live.txt', { touchedAt: LATER }));
      await store.touchStoredFile('a', LATER);
      expect((await store.deadStoredUploads(AT)).map((record) => record.id)).toEqual(['stale']);
      expect((await store.expiredStoredFiles(AT)).map((record) => record.id)).toEqual(['run']);
      expect((await store.storedFileIdsAmong(['a', 'nope', 'live'])).sort()).toEqual(['a', 'live']);
      await store.saveFileShare({ id: 's1', token: 'abcdefghijklmnopqrstuvwxyz012345', ownerId: 'u1', fileId: 'a', path: 'a.txt', name: 'a.txt', createdAt: AT, expiresAt: LATER });
      await store.deleteStoredFiles(['a', 'stale']);
      await store.deleteStoredFiles([]);
      expect(await store.storedFileIdsAmong(['a', 'stale', 'live'])).toEqual(['live']);
      expect(await store.getFileShares('u1')).toEqual([]);
      expect((await store.storedFileById('run'))?.changedAt).toBe(AT);
    });
  });

  describe('a run\'s artifacts', () => {
    it('keeps an artifact as saved, replaces it whole when saved again, and forgets it when deleted', async () => {
      const store = await make();
      await store.saveArtifact(artifact('a1'));
      expect(await store.getArtifacts('u1')).toEqual([artifact('a1')]);
      await store.saveArtifact(artifact('a1', { size: 99, place: 'mongo' }));
      expect(await store.getArtifacts('u1')).toEqual([artifact('a1', { size: 99, place: 'mongo' })]);
      await store.deleteArtifact('a1');
      expect(await store.getArtifacts('u1')).toEqual([]);
      await store.deleteArtifact('never');
    });

    it('lists a person\'s artifacts oldest first, only theirs, and only one run\'s when asked', async () => {
      const store = await make();
      await store.saveArtifact(artifact('late', { createdAt: '2026-10-29T00:00:00.000Z' }));
      await store.saveArtifact(artifact('early', { createdAt: '2026-10-27T00:00:00.000Z' }));
      await store.saveArtifact(artifact('other-run', { runId: 'run-2', createdAt: '2026-10-28T00:00:00.000Z' }));
      await store.saveArtifact(artifact('stranger', { ownerId: 'u2' }));
      expect((await store.getArtifacts('u1')).map((entry) => entry.id)).toEqual(['early', 'other-run', 'late']);
      expect((await store.getArtifacts('u1', 'run-2')).map((entry) => entry.id)).toEqual(['other-run']);
      expect((await store.getArtifacts('u1', 'run-9'))).toEqual([]);
      expect((await store.getArtifacts('u2')).map((entry) => entry.id)).toEqual(['stranger']);
      expect(await store.getArtifacts('nobody')).toEqual([]);
    });

    it('lists the artifacts that have expired by a time, the moment of expiry included', async () => {
      const store = await make();
      await store.saveArtifact(artifact('old', { expiresAt: '2026-11-01T00:00:00.000Z' }));
      await store.saveArtifact(artifact('edge', { expiresAt: '2026-11-05T00:00:00.000Z' }));
      await store.saveArtifact(artifact('fresh', { expiresAt: '2026-11-20T00:00:00.000Z' }));
      const expired = (await store.getExpiredArtifacts('2026-11-05T00:00:00.000Z')).map((entry) => entry.id).sort();
      expect(expired).toEqual(['edge', 'old']);
      expect(await store.getExpiredArtifacts('2026-10-01T00:00:00.000Z')).toEqual([]);
    });

    it('hands back a copy, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveArtifact(artifact('a1'));
      const [read] = await store.getArtifacts('u1');
      read!.name = 'changed';
      expect((await store.getArtifacts('u1'))[0]?.name).toBe('a1.png');
    });
  });

  describe('an artifact\'s chunks', () => {
    it('hands the bytes back in order, whatever order they were saved in', async () => {
      const store = await make();
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 2, data: Buffer.from([7, 8]) });
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 0, data: Buffer.from([0, 1, 255]) });
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 1, data: Buffer.from([4]) });
      await store.saveArtifactChunk({ artifactId: 'a2', ownerId: 'u1', n: 0, data: Buffer.from([9]) });
      const chunks = await store.getArtifactChunks('a1');
      expect(chunks.map((chunk) => chunk.n)).toEqual([0, 1, 2]);
      expect(chunks.map((chunk) => [...chunk.data])).toEqual([[0, 1, 255], [4], [7, 8]]);
      expect(chunks.every((chunk) => Buffer.isBuffer(chunk.data))).toBe(true);
      expect(chunks[0]).toMatchObject({ artifactId: 'a1', ownerId: 'u1' });
    });

    it('replaces a chunk saved again at the same place', async () => {
      const store = await make();
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 0, data: Buffer.from([1]) });
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 0, data: Buffer.from([2, 3]) });
      const chunks = await store.getArtifactChunks('a1');
      expect(chunks).toHaveLength(1);
      expect([...chunks[0]!.data]).toEqual([2, 3]);
    });

    it('removes every chunk of one artifact and none of another\'s', async () => {
      const store = await make();
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 0, data: Buffer.from([1]) });
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 1, data: Buffer.from([2]) });
      await store.saveArtifactChunk({ artifactId: 'a2', ownerId: 'u1', n: 0, data: Buffer.from([3]) });
      await store.deleteArtifactChunks('a1');
      expect(await store.getArtifactChunks('a1')).toEqual([]);
      expect(await store.getArtifactChunks('a2')).toHaveLength(1);
      await store.deleteArtifactChunks('never');
      expect(await store.getArtifactChunks('never')).toEqual([]);
    });

    it('hands back bytes of their own, so changing what it read changes nothing stored', async () => {
      const store = await make();
      await store.saveArtifactChunk({ artifactId: 'a1', ownerId: 'u1', n: 0, data: Buffer.from([1, 2, 3]) });
      (await store.getArtifactChunks('a1'))[0]!.data[0] = 99;
      expect([...(await store.getArtifactChunks('a1'))[0]!.data]).toEqual([1, 2, 3]);
    });
  });

  describe('where a person keeps their files', () => {
    it('keeps a person\'s settings, replaces them whole when saved again, and has none for someone else', async () => {
      const store = await make();
      expect(await store.getFileSettings('u1')).toBeUndefined();
      await store.saveFileSettings({ ownerId: 'u1', deploymentId: 'minio-1' });
      await store.saveFileSettings({ ownerId: 'u2', deploymentId: 'minio-2' });
      expect(await store.getFileSettings('u1')).toEqual({ ownerId: 'u1', deploymentId: 'minio-1' });
      await store.saveFileSettings({ ownerId: 'u1' });
      expect(await store.getFileSettings('u1')).toEqual({ ownerId: 'u1' });
      expect(await store.getFileSettings('u2')).toEqual({ ownerId: 'u2', deploymentId: 'minio-2' });
    });
  });

  describe('share links', () => {
    it('finds a link by its id and by its token, with the token as it was saved', async () => {
      const store = await make();
      await store.saveFileShare(share('s1', TOKEN, { projectId: 'p1', etag: 'e1' }));
      expect(await store.getFileShare('s1')).toEqual(share('s1', TOKEN, { projectId: 'p1', etag: 'e1' }));
      expect(await store.getFileShareByToken(TOKEN)).toEqual(share('s1', TOKEN, { projectId: 'p1', etag: 'e1' }));
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
      await store.saveFileShare(share('s1', TOKEN, { etag: 'e1' }));
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
