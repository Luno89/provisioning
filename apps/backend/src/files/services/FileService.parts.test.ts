import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { dropBody } from '../lib/drops.js';
import { fileServiceBehaviour } from '../testing/file-service-behaviour.js';
import { storedFilesTwin } from '../testing/stored-files-twin.js';
import { FileService } from './FileService.js';

fileServiceBehaviour(async () => {
  const twin = storedFilesTwin({ now: Date.now() });
  return { files: twin.files, shares: twin.records };
});

const project = { kind: 'project' as const, project: { id: 'p1' } };

const setUp = () => {
  const twin = storedFilesTwin({ now: Date.now() });
  return { twin, service: new FileService({ files: twin.files, shares: twin.records }) };
};

describe('a drop kept by the file service with the stored files twin', () => {
  it('keeps a drop of several files in one commit', async () => {
    const { twin, service } = setUp();
    const committing = vi.spyOn(twin.activities, 'StoredFilesCommitActivity');
    const files = ['a', 'b', 'c', 'd'].map((path) => ({ path, bytes: Buffer.from(path) }));
    const kept = await service.drop('u1', project, Readable.from([dropBody({}, files)]), undefined);
    expect(kept.ok && kept.value.files.map((file) => file.path)).toEqual(['a', 'b', 'c', 'd']);
    expect(committing).toHaveBeenCalledOnce();
    expect(committing.mock.calls[0]![0].commits).toHaveLength(4);
  });

  it('keeps none of a drop whose commit fails, removing every byte it sent', async () => {
    const { twin, service } = setUp();
    vi.spyOn(twin.activities, 'StoredFilesCommitActivity').mockResolvedValueOnce({ ok: false, status: 404, why: 'the bytes of upload f0003 are not in the instance\'s MinIO' });
    const files = ['a', 'b', 'c'].map((path) => ({ path, bytes: Buffer.from(path) }));
    expect(await service.drop('u1', project, Readable.from([dropBody({}, files)]), undefined)).toEqual({ ok: false, status: 404, why: 'the bytes of upload f0003 are not in the instance\'s MinIO' });
    expect(await service.list('u1', project, '')).toEqual({ ok: true, value: [] });
    expect(twin.objects.kept.size).toBe(0);
    expect(await twin.records.storedFilesIn('u1', { kind: 'project', id: 'p1' })).toEqual([]);
  });

  it('keeps none of a drop refused part way, removing what it had already sent', async () => {
    const { twin, service } = setUp();
    await service.upload('u1', project, 'c', Readable.from([Buffer.from('old')]), 3, 'text/plain', { replace: true });
    const files = ['a', 'b', 'c'].map((path) => ({ path, bytes: Buffer.from(path) }));
    expect(await service.drop('u1', project, Readable.from([dropBody({}, files)]), undefined)).toMatchObject({ ok: false, status: 409, exists: ['c'] });
    expect([...twin.objects.kept.values()].map((object) => object.bytes.toString())).toEqual(['old']);
    expect((await twin.records.storedFilesIn('u1', { kind: 'project', id: 'p1' })).map((record) => record.path)).toEqual(['c']);
  });

  it('takes a drop or an upload exactly as large as the room left, and refuses one byte more', async () => {
    const { twin, service } = setUp();
    twin.room.free = 3;
    const drop = dropBody({}, [{ path: 'a', bytes: Buffer.from('a') }]);
    expect((await service.drop('u1', project, Readable.from([drop]), 3)).ok).toBe(true);
    expect(await service.drop('u1', project, Readable.from([drop]), 4)).toEqual({ ok: false, status: 507, why: 'This needs 4 bytes, and 3 bytes is free', needed: 4, free: 3 });
    expect((await service.upload('u1', project, 'b', Readable.from([Buffer.from('bbb')]), 3, 'text/plain', { replace: false })).ok).toBe(true);
    expect(await service.upload('u1', project, 'c', Readable.from([Buffer.from('cccc')]), 4, 'text/plain', { replace: false })).toEqual({ ok: false, status: 507, why: 'This needs 4 bytes, and 3 bytes is free', needed: 4, free: 3 });
    expect(await service.room()).toEqual({ free: 3 });
    const big = dropBody({}, [{ path: 'd', bytes: Buffer.from('d') }, { path: 'e', bytes: Buffer.from('eeee') }]);
    expect(await service.drop('u1', project, Readable.from([big]), undefined)).toMatchObject({ ok: false, status: 507, needed: 4, free: 3 });
    expect(await service.download('u1', project, 'd')).toMatchObject({ ok: false, status: 404 });
  });
});
