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
  room: { free: number };
}

export const PLENTY_OF_ROOM = 1024 ** 4;

export const EVERY_PROJECT_OPEN = async (): Promise<boolean> => true;

export function storedFilesTwin(clock: { now: number } = { now: Date.parse('2026-11-07T10:00:00.000Z') }, room: { free: number } = { free: PLENTY_OF_ROOM }): StoredFilesTwin {
  const records = new MemoryFilesStore();
  const objects = new MemoryObjectStore();
  const activities = createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN, now: () => clock.now });
  let next = 0;
  const files = new StoredFiles({ records, objects, commits: inProcessCommits(activities), room: async () => room.free, now: () => clock.now, newId: () => `f${(next += 1).toString().padStart(4, '0')}` });
  return { files, records, objects, activities, room };
}

export function storedFilesOn(records: FilesStore, objects: MemoryObjectStore = new MemoryObjectStore(), room: { free: number } = { free: PLENTY_OF_ROOM }): { files: StoredFiles; objects: MemoryObjectStore; activities: StoredFilesActivities; room: { free: number } } {
  const activities = createStoredFilesActivities({ records, objects, holdOpen: EVERY_PROJECT_OPEN });
  return { files: new StoredFiles({ records, objects, commits: inProcessCommits(activities), room: async () => room.free }), objects, activities, room };
}
