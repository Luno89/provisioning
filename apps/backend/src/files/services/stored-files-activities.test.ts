import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { DEAD_AFTER_MS, type StoredFileRecord } from '../lib/stored-files.js';
import { SWEEP_BATCH } from '../lib/stored-files-work.js';
import type { ObjectStore } from './ObjectStore.js';
import { createStoredFilesActivities, type StoredFilesActivityDeps } from './stored-files-activities.js';

const T0 = Date.parse('2026-11-07T10:00:00.000Z');
const AT = new Date(T0).toISOString();

const record = (id: string, extra: Partial<StoredFileRecord> = {}): StoredFileRecord => ({
  id, objectId: id, ownerId: 'u1', scope: { kind: 'project', id: 'p1' }, path: `${id}.txt`, kind: 'file', size: 1, contentType: 'text/plain', version: 1,
  madeAt: AT, changedAt: AT, state: 'stored', touchedAt: AT, ...extra,
});

async function* listed(ids: readonly string[]): AsyncIterable<string> {
  for (const id of ids) yield id;
}

const setUp = (bytes: readonly string[] = []) => {
  const records = mock<StoredFilesActivityDeps['records']>();
  const objects = mock<ObjectStore>();
  objects.ids.mockImplementation(() => listed(bytes));
  records.deadStoredUploads.mockResolvedValue([]);
  records.expiredStoredFiles.mockResolvedValue([]);
  records.storedObjectIdsAmong.mockResolvedValue([]);
  const holdOpen = async () => true;
  return { records, objects, holdOpen, activities: createStoredFilesActivities({ records, objects, holdOpen, now: () => T0 }) };
};

const ids = (count: number, from = 0): string[] => Array.from({ length: count }, (_, index) => `o${index + from}`);

describe('committing stored files', () => {
  it('checks each upload\'s bytes by the upload\'s own object, which is what a new version takes', async () => {
    const { records, objects, activities } = setUp();
    objects.stat.calledWith('upload').mockResolvedValue({ size: 2 });
    records.commitStoredFiles.mockResolvedValue({ ok: true, stored: [record('file', { objectId: 'upload', version: 2 })], replaced: ['before'], absorbed: ['upload'] });
    expect(await activities.StoredFilesCommitActivity({ commits: [{ id: 'upload', size: 2 }], replace: true })).toMatchObject({ ok: true, replaced: ['before'] });
    expect(objects.stat).toHaveBeenCalledExactlyOnceWith('upload');
  });

  it('commits once every upload\'s bytes are there at the size it was kept with, at the time now', async () => {
    const { records, objects, holdOpen, activities } = setUp();
    objects.stat.calledWith('a').mockResolvedValue({ size: 3 });
    objects.stat.calledWith('b').mockResolvedValue({ size: 0 });
    const plan = { ok: true as const, stored: [record('a'), record('b')], replaced: [], absorbed: [] };
    records.commitStoredFiles.mockResolvedValue(plan);
    const commits = [{ id: 'a', size: 3 }, { id: 'b', size: 0 }];
    expect(await activities.StoredFilesCommitActivity({ commits, replace: true })).toBe(plan);
    expect(records.commitStoredFiles, 'the save holds each project open in its own transaction').toHaveBeenCalledWith(commits, { replace: true, holdOpen }, AT);
  });

  it('passes on that replacing is not allowed, and the store\'s refusal', async () => {
    const { records, objects, holdOpen, activities } = setUp();
    objects.stat.mockResolvedValue({ size: 1 });
    records.commitStoredFiles.mockResolvedValue({ ok: false, status: 409, why: 'a is already there, and it may not be replaced' });
    expect(await activities.StoredFilesCommitActivity({ commits: [{ id: 'a', size: 1 }], replace: false }))
      .toEqual({ ok: false, status: 409, why: 'a is already there, and it may not be replaced' });
    expect(records.commitStoredFiles).toHaveBeenCalledWith([{ id: 'a', size: 1 }], { replace: false, holdOpen }, AT);
  });

  it('refuses when an upload\'s bytes are not there, stopping at the first and committing nothing', async () => {
    const { records, objects, activities } = setUp();
    objects.stat.calledWith('a').mockResolvedValue({ size: 1 });
    objects.stat.calledWith('gone').mockResolvedValue(undefined);
    expect(await activities.StoredFilesCommitActivity({ commits: [{ id: 'a', size: 1 }, { id: 'gone', size: 1 }, { id: 'c', size: 1 }], replace: true }))
      .toEqual({ ok: false, status: 404, why: 'the bytes of upload gone are not in the instance\'s MinIO' });
    expect(objects.stat).not.toHaveBeenCalledWith('c');
    expect(records.commitStoredFiles).not.toHaveBeenCalled();
  });

  it('refuses when an upload holds more or fewer bytes than it was kept with', async () => {
    const { records, objects, activities } = setUp();
    objects.stat.calledWith('big').mockResolvedValue({ size: 6 });
    objects.stat.calledWith('small').mockResolvedValue({ size: 4 });
    expect(await activities.StoredFilesCommitActivity({ commits: [{ id: 'big', size: 5 }], replace: true }))
      .toEqual({ ok: false, status: 400, why: 'upload big holds 6 bytes, not the 5 it was kept with' });
    expect(await activities.StoredFilesCommitActivity({ commits: [{ id: 'small', size: 5 }], replace: true }))
      .toEqual({ ok: false, status: 400, why: 'upload small holds 4 bytes, not the 5 it was kept with' });
    expect(records.commitStoredFiles).not.toHaveBeenCalled();
  });

  it('hands an empty commit straight to the store', async () => {
    const { records, objects, activities } = setUp();
    records.commitStoredFiles.mockResolvedValue({ ok: true, stored: [], replaced: [], absorbed: [] });
    expect(await activities.StoredFilesCommitActivity({ commits: [], replace: false })).toEqual({ ok: true, stored: [], replaced: [], absorbed: [] });
    expect(objects.stat).not.toHaveBeenCalled();
  });

  it('reads the time from the clock when none is handed to it', async () => {
    const records = mock<StoredFilesActivityDeps['records']>();
    records.commitStoredFiles.mockResolvedValue({ ok: true, stored: [], replaced: [], absorbed: [] });
    await createStoredFilesActivities({ records, objects: mock<ObjectStore>(), holdOpen: async () => true }).StoredFilesCommitActivity({ commits: [], replace: true });
    const at = records.commitStoredFiles.mock.calls[0]![2];
    expect(Math.abs(Date.parse(at) - Date.now())).toBeLessThan(60_000);
  });
});

describe('forgetting and removing bytes', () => {
  it('forgets the records named', async () => {
    const { records, objects, activities } = setUp();
    await activities.StoredFilesForgetActivity({ ids: ['a', 'b'] });
    expect(records.deleteStoredFiles).toHaveBeenCalledWith(['a', 'b']);
    expect(objects.remove).not.toHaveBeenCalled();
  });

  it('removes the bytes of each object named, one after another', async () => {
    const { records, objects, activities } = setUp();
    await activities.StoredFilesRemoveBytesActivity({ objectIds: ['a', 'b'] });
    expect(objects.remove.mock.calls).toEqual([['a'], ['b']]);
    expect(records.deleteStoredFiles).not.toHaveBeenCalled();
  });

  it('removes nothing for no objects', async () => {
    const { objects, activities } = setUp();
    await activities.StoredFilesRemoveBytesActivity({ objectIds: [] });
    expect(objects.remove).not.toHaveBeenCalled();
  });
});

describe('the sweep', () => {
  it('asks for uploads untouched for the dead time and files expired by now', async () => {
    const { records, activities } = setUp();
    await activities.StoredFilesSweepActivity();
    expect(records.deadStoredUploads).toHaveBeenCalledWith(new Date(T0 - DEAD_AFTER_MS).toISOString());
    expect(records.expiredStoredFiles).toHaveBeenCalledWith(AT);
  });

  it('forgets dead uploads and expired files and removes the bytes each record names, and counts each', async () => {
    const { records, objects, activities } = setUp();
    records.deadStoredUploads.mockResolvedValue([record('dead', { state: 'uploading' })]);
    records.expiredStoredFiles.mockResolvedValue([record('old1', { objectId: 'v2-of-old1' }), record('old2')]);
    expect(await activities.StoredFilesSweepActivity()).toEqual({ deadUploads: 1, expired: 2, orphans: 0 });
    expect(records.deleteStoredFiles).toHaveBeenCalledWith(['dead', 'old1', 'old2']);
    expect(objects.remove.mock.calls).toEqual([['dead'], ['v2-of-old1'], ['old2']]);
    expect(records.deleteStoredFiles.mock.invocationCallOrder[0]!).toBeLessThan(objects.remove.mock.invocationCallOrder[0]!);
  });

  it('sweeps nothing when nothing is dead, expired or unknown', async () => {
    const { records, objects, activities } = setUp();
    expect(await activities.StoredFilesSweepActivity()).toEqual({ deadUploads: 0, expired: 0, orphans: 0 });
    expect(records.deleteStoredFiles).toHaveBeenCalledWith([]);
    expect(records.storedObjectIdsAmong).not.toHaveBeenCalled();
    expect(objects.remove).not.toHaveBeenCalled();
  });

  it('removes bytes no record names and keeps those a record does', async () => {
    const { records, objects, activities } = setUp(['kept', 'orphan', 'also-kept']);
    records.storedObjectIdsAmong.mockResolvedValue(['kept', 'also-kept']);
    expect(await activities.StoredFilesSweepActivity()).toEqual({ deadUploads: 0, expired: 0, orphans: 1 });
    expect(records.storedObjectIdsAmong).toHaveBeenCalledWith(['kept', 'orphan', 'also-kept']);
    expect(objects.remove.mock.calls).toEqual([['orphan']]);
  });

  it('asks about a full batch at once and leaves nothing to ask after it', async () => {
    const { records, activities } = setUp(ids(SWEEP_BATCH));
    records.storedObjectIdsAmong.mockImplementation(async (among) => [...among]);
    expect(await activities.StoredFilesSweepActivity()).toEqual({ deadUploads: 0, expired: 0, orphans: 0 });
    expect(records.storedObjectIdsAmong).toHaveBeenCalledTimes(1);
    expect(records.storedObjectIdsAmong.mock.calls[0]![0]).toHaveLength(SWEEP_BATCH);
  });

  it('asks about one more than a batch in a full batch and then the one left', async () => {
    const { records, objects, activities } = setUp(ids(SWEEP_BATCH + 1));
    records.storedObjectIdsAmong.mockResolvedValue([]);
    expect(await activities.StoredFilesSweepActivity()).toEqual({ deadUploads: 0, expired: 0, orphans: SWEEP_BATCH + 1 });
    expect(records.storedObjectIdsAmong.mock.calls.map(([among]) => among.length)).toEqual([SWEEP_BATCH, 1]);
    expect(records.storedObjectIdsAmong.mock.calls[1]![0]).toEqual([`o${SWEEP_BATCH}`]);
    expect(objects.remove).toHaveBeenCalledTimes(SWEEP_BATCH + 1);
  });

  it('asks about one less than a batch once, at the end', async () => {
    const { records, activities } = setUp(ids(SWEEP_BATCH - 1));
    records.storedObjectIdsAmong.mockImplementation(async (among) => [...among]);
    await activities.StoredFilesSweepActivity();
    expect(records.storedObjectIdsAmong.mock.calls.map(([among]) => among.length)).toEqual([SWEEP_BATCH - 1]);
  });

  it('counts orphans across batches', async () => {
    const { records, activities } = setUp(ids(2 * SWEEP_BATCH + 2));
    records.storedObjectIdsAmong.mockImplementation(async (among) => among.filter((id) => Number(id.slice(1)) % 2 === 0));
    expect((await activities.StoredFilesSweepActivity()).orphans).toBe(SWEEP_BATCH + 1);
    expect(records.storedObjectIdsAmong.mock.calls.map(([among]) => among.length)).toEqual([SWEEP_BATCH, SWEEP_BATCH, 2]);
  });
});
