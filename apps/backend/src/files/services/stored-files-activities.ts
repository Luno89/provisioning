import { DEAD_AFTER_MS } from '../lib/stored-files.js';
import { SWEEP_BATCH, type StoredFilesActivities } from '../lib/stored-files-work.js';
import type { FilesStore } from '../store.js';
import type { ObjectStore } from './ObjectStore.js';

export interface StoredFilesActivityDeps {
  records: Pick<FilesStore, 'commitStoredFiles' | 'deleteStoredFiles' | 'deadStoredUploads' | 'expiredStoredFiles' | 'storedFileIdsAmong'>;
  objects: ObjectStore;
  now?: () => number;
}

export function createStoredFilesActivities(deps: StoredFilesActivityDeps): StoredFilesActivities {
  const now = deps.now ?? Date.now;
  const removeBytes = async (ids: readonly string[]): Promise<void> => {
    for (const id of ids) await deps.objects.remove(id);
  };
  return {
    async StoredFilesCommitActivity({ commits, replace }) {
      for (const commit of commits) {
        const stat = await deps.objects.stat(commit.id);
        if (!stat) return { ok: false, status: 404, why: `the bytes of upload ${commit.id} are not in the instance's MinIO` };
        if (stat.size !== commit.size) return { ok: false, status: 400, why: `upload ${commit.id} holds ${stat.size} bytes, not the ${commit.size} it was kept with` };
      }
      return deps.records.commitStoredFiles(commits, { replace }, new Date(now()).toISOString());
    },
    async StoredFilesForgetActivity({ ids }) {
      await deps.records.deleteStoredFiles(ids);
    },
    async StoredFilesRemoveBytesActivity({ ids }) {
      await removeBytes(ids);
    },
    async StoredFilesSweepActivity() {
      const at = now();
      const dead = await deps.records.deadStoredUploads(new Date(at - DEAD_AFTER_MS).toISOString());
      const expired = await deps.records.expiredStoredFiles(new Date(at).toISOString());
      const going = [...dead, ...expired].map((record) => record.id);
      await deps.records.deleteStoredFiles(going);
      await removeBytes(going);
      let orphans = 0;
      let batch: string[] = [];
      const settle = async (): Promise<void> => {
        const known = new Set(await deps.records.storedFileIdsAmong(batch));
        const unknown = batch.filter((id) => !known.has(id));
        await removeBytes(unknown);
        orphans += unknown.length;
        batch = [];
      };
      for await (const id of deps.objects.ids()) {
        batch.push(id);
        if (batch.length >= SWEEP_BATCH) await settle();
      }
      if (batch.length > 0) await settle();
      return { deadUploads: dead.length, expired: expired.length, orphans };
    },
  };
}
