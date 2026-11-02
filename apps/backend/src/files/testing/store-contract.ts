import { describe, expect, it } from 'vitest';
import type { StoredArtifact } from '../lib/artifacts.js';
import type { FileShare } from '../lib/file-shares.js';
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

export function filesStoreContract(make: () => Promise<FilesStore>): void {
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
