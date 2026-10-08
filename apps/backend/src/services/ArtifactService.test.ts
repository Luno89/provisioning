import { describe, it, expect } from 'vitest';
import { ArtifactService, type ObjectStore } from './ArtifactService.js';
import { MemoryDB } from '../lib/memory-db.js';
import { MAX_RUN_BYTES, CHUNK_BYTES, objectKey } from '../lib/artifacts.js';

const bucket = () => {
  const objects = new Map<string, Buffer>();
  const store: ObjectStore = {
    put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); },
    get: async (key) => {
      const found = objects.get(key);
      if (!found) throw new Error(`no ${key}`);
      return found;
    },
    remove: async (key) => { objects.delete(key); },
  };
  return { objects, store };
};

let clock = '2026-10-08T12:00:00.000Z';
let ids = 0;
const service = (records: MemoryDB, minio?: ObjectStore) => new ArtifactService({
  records,
  minioFor: async () => minio,
  now: () => clock,
  newId: () => `a${++ids}`,
});

describe('keeping a run\'s failure artifacts', () => {
  it('goes to Mongo in chunks when the owner has no MinIO, and says MinIO was missing', async () => {
    const db = new MemoryDB();
    const big = Buffer.alloc(CHUNK_BYTES * 2 + 10, 7);
    const kept = await service(db).put('bo', 'run-1', [{ name: 'test-failed-1.png', bytes: big }]);

    expect(kept.place).toBe('mongo');
    expect(kept.minioMissing).toBe(true);
    expect(kept.stored[0]).toMatchObject({ name: 'test-failed-1.png', contentType: 'image/png', size: big.length, expiresAt: '2026-10-22T12:00:00.000Z' });
    expect(await db.getArtifactChunks(kept.stored[0]!.id)).toHaveLength(3);

    const read = await service(db).get('bo', kept.stored[0]!.id);
    expect(read!.bytes.equals(big)).toBe(true);
  });

  it('goes to the owner\'s MinIO when one is there, leaving no chunks', async () => {
    const db = new MemoryDB();
    const { objects, store } = bucket();
    const kept = await service(db, store).put('bo', 'run-1', [{ name: 'trace.zip', bytes: Buffer.from('zip') }]);

    expect(kept).toMatchObject({ place: 'minio', minioMissing: false });
    expect([...objects.keys()]).toEqual([objectKey(kept.stored[0]!)]);
    expect(await db.getArtifactChunks(kept.stored[0]!.id)).toEqual([]);
    expect((await service(db, store).get('bo', kept.stored[0]!.id))!.bytes.toString()).toBe('zip');
  });

  it('keeps a run under its budget, dropping what does not fit and saying so', async () => {
    const db = new MemoryDB();
    const half = Buffer.alloc(MAX_RUN_BYTES / 2 + 1);
    const first = await service(db).put('bo', 'run-1', [{ name: 'a.webm', bytes: half }]);
    const second = await service(db).put('bo', 'run-1', [{ name: 'b.webm', bytes: half }, { name: 'c.png', bytes: Buffer.from('png') }]);

    expect(first.stored).toHaveLength(1);
    expect(second.stored.map((a) => a.name)).toEqual(['c.png']);
    expect(second.dropped).toEqual(['b.webm']);
  });

  it('never hands one owner another\'s artifact', async () => {
    const db = new MemoryDB();
    const kept = await service(db).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    expect(await service(db).get('al', kept.stored[0]!.id)).toBeUndefined();
    expect(await service(db).list('al', 'run-1')).toEqual([]);
  });

  it('sweeps what has expired from wherever it was kept', async () => {
    const db = new MemoryDB();
    const { objects, store } = bucket();
    const inMongo = await service(db).put('bo', 'run-1', [{ name: 'a.png', bytes: Buffer.from('x') }]);
    const inMinio = await service(db, store).put('bo', 'run-2', [{ name: 'b.png', bytes: Buffer.from('y') }]);

    clock = '2026-10-21T12:00:00.000Z';
    expect(await service(db, store).sweep()).toBe(0);
    clock = '2026-10-23T12:00:00.000Z';
    expect(await service(db, store).sweep()).toBe(2);

    expect(await db.getArtifactChunks(inMongo.stored[0]!.id)).toEqual([]);
    expect(objects.size).toBe(0);
    expect(await service(db).list('bo', 'run-2')).toEqual([]);
    expect(inMinio.stored).toHaveLength(1);
  });
});

describe('a check\'s space handing its runs to the person', () => {
  it('hands over the runs\' artifacts too, so they outlive the space', async () => {
    const db = new MemoryDB();
    const kept = await service(db).put('space-1', 'run-9', [{ name: 'a.png', bytes: Buffer.from('shot') }]);
    await db.reownRuns('space-1', 'bo');
    const before = await service(db).put('space-1', 'run-10', [{ name: 'b.png', bytes: Buffer.from('gone') }]);
    const removed = await db.removeAccountRecords('space-1', { watermarkKeys: [], ingestIds: [], projectIds: [] });
    expect(removed).toMatchObject({ artifacts: 1, artifactChunks: 1 });
    expect(await db.getArtifactChunks(before.stored[0]!.id)).toEqual([]);

    expect(await service(db).list('space-1', 'run-9')).toEqual([]);
    expect((await service(db).get('bo', kept.stored[0]!.id))!.bytes.toString()).toBe('shot');
  });
});
