import { describe, it, expect } from 'vitest';
import { specsToSeed, BUILT_IN_SPECS, MINIO_SPEC, type StoredAppSpec, type AppSpec } from './app-spec.js';
import { validateSpec } from './app-spec-validate.js';

const stored = (id: string, spec: AppSpec, over: Partial<StoredAppSpec> = {}): StoredAppSpec => ({
  id, spec, builtIn: true, createdAt: 'then', updatedAt: 'then', ...over,
});

describe('what gets written', () => {
  it('seeds everything into an empty database — the fresh-clone case', () => {
    expect(specsToSeed([]).map((s) => s.id)).toEqual(BUILT_IN_SPECS.map((s) => s.id));
  });

  it('writes nothing when the database already matches', () => {
    const already = BUILT_IN_SPECS.map((s) => stored(s.id, s));
    expect(specsToSeed(already)).toEqual([]);
  });

  it('ships a changed default', () => {
    const old = stored('minio', { ...MINIO_SPEC, image: 'minio/minio:old' });
    expect(specsToSeed([old], [MINIO_SPEC]).map((s) => s.id)).toEqual(['minio']);
  });
});

describe('what it must never overwrite', () => {
  it('leaves a built-in someone has EDITED alone', () => {
    const edited = stored('minio', { ...MINIO_SPEC, image: 'mine:1' }, { editedAt: 'yesterday' });
    expect(specsToSeed([edited], [MINIO_SPEC])).toEqual([]);
  });

  it('never touches a spec that is not built in', () => {
    const mine = stored('mongo', { ...MINIO_SPEC, id: 'mongo' }, { builtIn: false, ownerId: 'u1' });
    expect(specsToSeed([mine], [MINIO_SPEC]).map((s) => s.id)).toEqual(['minio']);
  });
});

describe('the seeds themselves', () => {
  it('all pass the validator', () => {
    for (const spec of BUILT_IN_SPECS) {
      expect(validateSpec(spec), spec.id).toEqual([]);
    }
  });

  it('have unique ids', () => {
    const ids = BUILT_IN_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only contains specs verified against their construct', () => {
    expect(BUILT_IN_SPECS.map((s) => s.id)).toEqual(['minio']);
  });
});
