import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { CHUNK_BYTES, MAX_RUN_BYTES, objectKey } from '../lib/artifacts.js';
import { ArtifactService, type ObjectStore } from './ArtifactService.js';

const bucket = () => {
  const objects = new Map<string, Buffer>();
  const store = mock<ObjectStore>();
  store.put.mockImplementation(async (key, bytes) => { objects.set(key, Buffer.from(bytes)); });
  store.get.mockImplementation(async (key) => {
    const found = objects.get(key);
    if (!found) throw new Error(`no ${key}`);
    return found;
  });
  store.remove.mockImplementation(async (key) => { objects.delete(key); });
  return { objects, store };
};

let clock = '2026-10-08T12:00:00.000Z';
let ids = 0;
const service = (records: ReturnType<typeof memoryDatabase>['files'], minio?: ObjectStore) => new ArtifactService({
  records,
  minioFor: async () => minio,
  now: () => clock,
  newId: () => `a${++ids}`,
});

describe('keeping a run\'s failure artifacts', () => {
  it('goes to the database in chunks when the owner has no MinIO, and says MinIO was missing', async () => {
    const { files } = memoryDatabase();
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 10, 7);
    const kept = await service(files).put('bo', 'run-1', [{ name: 'test-failed-1.png', bytes: big }]);

    expect(kept.place).toBe('mongo');
    expect(kept.minioMissing).toBe(true);
    expect(kept.stored[0]).toMatchObject({ name: 'test-failed-1.png', contentType: 'image/png', size: big.length, expiresAt: '2026-10-22T12:00:00.000Z' });
    expect(await files.getArtifactChunks(kept.stored[0]!.id)).toHaveLength(3);

    const read = await service(files).get('bo', kept.stored[0]!.id);
    expect(read!.bytes.equals(big)).toBe(true);
  });

  it('goes to the owner\'s MinIO when one is there, leaving no chunks', async () => {
    const { files } = memoryDatabase();
    const { objects, store } = bucket();
    const kept = await service(files, store).put('bo', 'run-1', [{ name: 'trace.zip', bytes: Buffer.from('zip') }]);

    expect(kept).toMatchObject({ place: 'minio', minioMissing: false });
    expect([...objects.keys()]).toEqual([objectKey(kept.stored[0]!)]);
    expect(store.put).toHaveBeenCalledWith(objectKey(kept.stored[0]!), Buffer.from('zip'), 'application/zip');
    expect(await files.getArtifactChunks(kept.stored[0]!.id)).toEqual([]);
    expect((await service(files, store).get('bo', kept.stored[0]!.id))!.bytes.toString()).toBe('zip');
  });

  it('keeps the artifact in the database, and says so, when the owner\'s MinIO cannot be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { files } = memoryDatabase();
    const away = new ArtifactService({ records: files, minioFor: async () => { throw new Error('connect ECONNREFUSED'); }, now: () => clock, newId: () => `a${++ids}` });
    const kept = await away.put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect(kept).toMatchObject({ place: 'mongo', minioMissing: true });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('keeps a run under its budget, dropping what does not fit and saying so', async () => {
    const { files } = memoryDatabase();
    const half = Buffer.alloc(MAX_RUN_BYTES / 2 + 1);
    const first = await service(files).put('bo', 'run-1', [{ name: 'a.webm', bytes: half }]);
    const second = await service(files).put('bo', 'run-1', [{ name: 'b.webm', bytes: half }, { name: 'c.png', bytes: Buffer.from('png') }]);

    expect(first.stored).toHaveLength(1);
    expect(second.stored.map((a) => a.name)).toEqual(['c.png']);
    expect(second.dropped).toEqual(['b.webm']);
  });

  it('lists a run\'s artifacts for its owner only, and never hands one owner another\'s artifact', async () => {
    const { files } = memoryDatabase();
    const kept = await service(files).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect((await service(files).list('bo', 'run-1')).map((artifact) => artifact.id)).toEqual([kept.stored[0]!.id]);
    expect(await service(files).get('al', kept.stored[0]!.id)).toBeUndefined();
    expect(await service(files).list('al', 'run-1')).toEqual([]);
  });

  it('refuses to read an artifact kept in MinIO when MinIO is not reachable now', async () => {
    const { files } = memoryDatabase();
    const { store } = bucket();
    const kept = await service(files, store).put('bo', 'run-1', [{ name: 'trace.zip', bytes: Buffer.from('zip') }]);
    await expect(service(files).get('bo', kept.stored[0]!.id)).rejects.toThrow('this artifact is kept in MinIO, which is not reachable now');
  });

  it('removes a run\'s artifacts from wherever they were kept', async () => {
    const { files } = memoryDatabase();
    const { objects, store } = bucket();
    const inDatabase = await service(files).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    await service(files, store).put('bo', 'run-1', [{ name: 'b.png', bytes: Buffer.from('y') }]);
    await service(files, store).put('bo', 'run-2', [{ name: 'c.png', bytes: Buffer.from('z') }]);

    expect(await service(files, store).removeRun('bo', 'run-1')).toBe(2);
    expect(await files.getArtifactChunks(inDatabase.stored[0]!.id)).toEqual([]);
    expect(await service(files).list('bo', 'run-1')).toEqual([]);
    expect(objects.size).toBe(1);
    expect(await service(files).list('bo', 'run-2')).toHaveLength(1);
  });

  it('sweeps what has expired from wherever it was kept', async () => {
    const { files } = memoryDatabase();
    const { objects, store } = bucket();
    clock = '2026-10-08T12:00:00.000Z';
    const inDatabase = await service(files).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    const inMinio = await service(files, store).put('bo', 'run-2', [{ name: 'b.png', bytes: Buffer.from('y') }]);

    clock = '2026-10-21T12:00:00.000Z';
    expect(await service(files, store).sweep()).toBe(0);
    clock = '2026-10-23T12:00:00.000Z';
    expect(await service(files, store).sweep()).toBe(2);

    expect(await files.getArtifactChunks(inDatabase.stored[0]!.id)).toEqual([]);
    expect(objects.size).toBe(0);
    expect(await service(files).list('bo', 'run-2')).toEqual([]);
    expect(inMinio.stored).toHaveLength(1);
  });

  it('keeps an expired artifact whose MinIO does not answer, so a later sweep removes it rather than leaving its bytes behind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { files } = memoryDatabase();
    const { objects, store } = bucket();
    clock = '2026-10-08T12:00:00.000Z';
    await service(files, store).put('bo', 'run-3', [{ name: 'c.png', bytes: Buffer.from('z') }]);
    clock = '2026-11-23T12:00:00.000Z';
    const unreachable = new ArtifactService({ records: files, minioFor: async () => { throw new Error('connect ECONNREFUSED'); }, now: () => clock });
    expect(await unreachable.sweep()).toBe(0);
    expect(await files.getArtifacts('bo', 'run-3')).toHaveLength(1);
    expect(await service(files, store).sweep()).toBe(1);
    expect(objects.size).toBe(0);
    warn.mockRestore();
  });

  it('stamps artifacts with the current time and a fresh id when it is given neither', async () => {
    const { files } = memoryDatabase();
    const kept = await new ArtifactService({ records: files, minioFor: async () => undefined }).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect(kept.stored[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Math.abs(Date.parse(kept.stored[0]!.createdAt) - Date.now())).toBeLessThan(60_000);
  });
});
