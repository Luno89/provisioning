import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedTreeTypes } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

/**
 * ── SEEDING FOLLOWS `ensurePersonas`, INCLUDING WHY ──
 *
 * Adds only. A type edited in the Lab must survive the next boot, or "editable" is a lie — the same
 * rule `ensureKoala` states and the reason it gives: "a migration that overwrites a deliberate
 * setting is worse than one that never ran."
 */

describe('seeding an owner\'s tree types', () => {
  const owned = async (db: MemoryDB, ownerId = 'u1') => (await db.getTreeTypes(ownerId));

  it('gives a new owner every shipped type', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db, 'u1');

    expect((await owned(db)).map((t) => t.id).sort()).toEqual(TREE_TYPE_SEEDS.map((s) => s.id).sort());
  });

  it('does not duplicate on a second run', async () => {
    // Boots happen. This runs on every one of them.
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db, 'u1');
    await seedTreeTypes(db, 'u1');

    expect(await owned(db)).toHaveLength(TREE_TYPE_SEEDS.length);
  });

  it('never overwrites an edit', async () => {
    /**
     * The property that makes these records rather than constants. Someone renames a type or
     * changes its image in the Lab; the next boot must leave that alone.
     */
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db, 'u1');

    const mine = (await owned(db)).find((t) => t.id === 'research-paper')!;
    await db.saveTreeType({ ...mine, label: 'My renamed type', language: 'python' });

    await seedTreeTypes(db, 'u1');

    const after = (await owned(db)).find((t) => t.id === 'research-paper')!;
    expect(after.label).toBe('My renamed type');
    expect(after.language).toBe('python');
  });

  it('adds a type shipped later without touching the rest', async () => {
    // The reason it is add-only rather than skip-if-any-exist: a new seed must still arrive.
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db, 'u1');
    await db.deleteTreeType('library', 'u1');
    const renamed = (await owned(db)).find((t) => t.id === 'dataset')!;
    await db.saveTreeType({ ...renamed, label: 'Kept' });

    await seedTreeTypes(db, 'u1');

    expect((await owned(db)).find((t) => t.id === 'library')).toBeDefined();
    expect((await owned(db)).find((t) => t.id === 'dataset')!.label).toBe('Kept');
  });

  it('keeps one owner\'s types out of another\'s', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db, 'u1');

    expect(await owned(db, 'u2')).toEqual([]);
  });

  it('backfills validationRecipe when missing on legacy records while preserving user edits', async () => {
    const db = new MemoryDB();
    await db.init();

    // Legacy record without validationRecipe or files
    await db.saveTreeType({
      id: 'api-service',
      ownerId: 'u1',
      label: 'Custom Service Name',
      summary: 'Custom summary',
      language: 'node',
      produces: 'service',
    } as any);

    await seedTreeTypes(db, 'u1');

    const updated = (await owned(db)).find((t) => t.id === 'api-service')!;
    expect(updated.label).toBe('Custom Service Name'); // User customization preserved
    expect(updated.validationRecipe).toBeDefined(); // Validation recipe backfilled!
    expect(updated.validationRecipe?.checks.length).toBeGreaterThan(0);
    expect(updated.files?.length).toBeGreaterThan(0);
  });
});
