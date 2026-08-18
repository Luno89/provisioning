import { describe, it, expect } from 'vitest';
import { specsToSeed, BUILT_IN_SPECS, MINIO_SPEC, type StoredAppSpec, type AppSpec } from './app-spec.js';
import { validateSpec } from './app-spec-validate.js';

/**
 * Seeding the built-in specs, so a fresh clone is functional.
 *
 * ── WHY A REPO AND A DATABASE ──
 * Specs live in the database so they can be edited at runtime, which is the point. But a fresh
 * `git clone && npm run setup` starts with an empty one, and a platform that can deploy nothing
 * until somebody types a spec is not functional. The repo carries the seeds; the database is the
 * runtime source — one place to read from, so there is no second lookup path to drift.
 *
 * Seeding runs on every start, which is what makes the rules below matter.
 */

const stored = (id: string, spec: AppSpec, over: Partial<StoredAppSpec> = {}): StoredAppSpec => ({
  id, spec, builtIn: true, createdAt: 'then', updatedAt: 'then', ...over,
});

describe('what gets written', () => {
  it('seeds everything into an empty database — the fresh-clone case', () => {
    expect(specsToSeed([]).map((s) => s.id)).toEqual(BUILT_IN_SPECS.map((s) => s.id));
  });

  it('writes nothing when the database already matches', () => {
    // Seeding on every start must not churn `updatedAt` on every start.
    const already = BUILT_IN_SPECS.map((s) => stored(s.id, s));
    expect(specsToSeed(already)).toEqual([]);
  });

  it('ships a changed default', () => {
    // A fix to a built-in has to reach an instance that already has the old one.
    const old = stored('minio', { ...MINIO_SPEC, image: 'minio/minio:old' });
    expect(specsToSeed([old], [MINIO_SPEC]).map((s) => s.id)).toEqual(['minio']);
  });
});

describe('what it must never overwrite', () => {
  it('leaves a built-in someone has EDITED alone', () => {
    /**
     * The rule that makes runtime editing real. Reverting a deliberate change on every restart is
     * worse than shipping an out-of-date default — the user would fix it, restart, and find it
     * undone with nothing saying why.
     */
    const edited = stored('minio', { ...MINIO_SPEC, image: 'mine:1' }, { editedAt: 'yesterday' });
    expect(specsToSeed([edited], [MINIO_SPEC])).toEqual([]);
  });

  it('never touches a spec that is not built in', () => {
    // A spec Koala wrote is not the repo's to manage, and its absence from the repo is not a
    // reason to delete or replace it.
    const mine = stored('mongo', { ...MINIO_SPEC, id: 'mongo' }, { builtIn: false, ownerId: 'u1' });
    expect(specsToSeed([mine], [MINIO_SPEC]).map((s) => s.id)).toEqual(['minio']);
  });
});

describe('the seeds themselves', () => {
  it('all pass the validator', () => {
    /**
     * If a spec we ship cannot be stored, the rules are wrong rather than the spec — and seeding
     * would fail silently on every start.
     */
    for (const spec of BUILT_IN_SPECS) {
      expect(validateSpec(spec), spec.id).toEqual([]);
    }
  });

  it('have unique ids', () => {
    // The id is the storage key; two seeds sharing one would have the second overwrite the first.
    const ids = BUILT_IN_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('only contains specs verified against their construct', () => {
    /**
     * `minio` is here because app-spec.test.ts renders it and checks the result field for field
     * against minio-native.ts. This list grows as each construct is checked that way — adding one
     * without it would be asserting the abstraction fits rather than showing it.
     */
    expect(BUILT_IN_SPECS.map((s) => s.id)).toEqual(['minio']);
  });
});
