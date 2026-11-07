import { doStoredFilesWork, type StoredFilesActivities } from '../lib/stored-files-work.js';
import { createStoredFilesActivities } from '../services/stored-files-activities.js';
import { StoredFiles, type StoredFileCommits } from '../services/StoredFiles.js';
import { MemoryObjectStore } from './memory-object-store.js';
import { MemoryFilesStore } from './memory-store.js';
import type { FilesStore } from '../store.js';

export function inProcessCommits(activities: StoredFilesActivities): StoredFileCommits {
  return {
    async commit(_ownerId, commits, { replace }) {
      const done = await doStoredFilesWork({ op: 'commit', ownerId: _ownerId, commits: [...commits], replace }, activities);
      if (done.op !== 'commit') throw new Error(`a commit came back as ${done.op}`);
      return done.plan;
    },
    async remove(ownerId, files) {
      await doStoredFilesWork({ op: 'remove', ownerId, ids: files.map((file) => file.id), objectIds: files.map((file) => file.objectId) }, activities);
    },
  };
}

export interface StoredFilesTwin {
  files: StoredFiles;
  records: MemoryFilesStore;
  objects: MemoryObjectStore;
  activities: StoredFilesActivities;
}

export function storedFilesTwin(clock: { now: number } = { now: Date.parse('2026-11-07T10:00:00.000Z') }): StoredFilesTwin {
  const records = new MemoryFilesStore();
  const objects = new MemoryObjectStore();
  const activities = createStoredFilesActivities({ records, objects, now: () => clock.now });
  let next = 0;
  const files = new StoredFiles({ records, objects, commits: inProcessCommits(activities), now: () => clock.now, newId: () => `f${(next += 1).toString().padStart(4, '0')}` });
  return { files, records, objects, activities };
}

export function storedFilesOn(records: FilesStore, objects: MemoryObjectStore = new MemoryObjectStore()): { files: StoredFiles; objects: MemoryObjectStore; activities: StoredFilesActivities } {
  const activities = createStoredFilesActivities({ records, objects });
  return { files: new StoredFiles({ records, objects, commits: inProcessCommits(activities) }), objects, activities };
}
