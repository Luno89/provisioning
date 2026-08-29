import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedTreeTypes } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

describe('seeding an owner\'s tree types', () => {
  const owned = async (db: MemoryDB, ownerId = 'u1') => (await db.getTreeTypes(ownerId));

  it('gives a new owner every shipped type', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db, 'u1');

    expect((await owned(db)).map((t) => t.id).sort()).toEqual(TREE_TYPE_SEEDS.map((s) => s.id).sort());
  });

  it('does not duplicate on a second run', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db, 'u1');
    await seedTreeTypes(db, 'u1');

    expect(await owned(db)).toHaveLength(TREE_TYPE_SEEDS.length);
  });

  it('never overwrites an edit', async () => {
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
    expect(updated.label).toBe('Custom Service Name');
    expect(updated.validationRecipe).toBeDefined();
    expect(updated.validationRecipe?.checks.length).toBeGreaterThan(0);
    expect(updated.files?.length).toBeGreaterThan(0);
  });
});
