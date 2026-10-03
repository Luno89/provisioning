import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedTreeTypes, resolveTreeType } from './tree-types.js';
import { TREE_TYPE_SEEDS } from './tree-type-seeds.js';

describe('seeding an owner\'s tree types', () => {
  const owned = async (db: MemoryDB, ownerId = 'u1') => (await db.getTreeTypes(ownerId));

  it('gives a new owner every shipped type', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db);

    expect((await owned(db)).map((t) => t.id).sort()).toEqual(TREE_TYPE_SEEDS.map((s) => s.id).sort());
  });

  it('does not duplicate on a second run', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db);
    await seedTreeTypes(db);

    expect(await owned(db)).toHaveLength(TREE_TYPE_SEEDS.length);
  });

  it("never overwrites a person's edit of a shipped type", async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);

    // The product writes an edit as the person's own row, which shadows the shipped one by id.
    const shipped = (await db.getTreeTypes()).find((t) => t.id === 'research-paper')!;
    await db.saveTreeType({ ...shipped, ownerId: 'u1', label: 'My renamed type', language: 'python' });

    await seedTreeTypes(db);

    const mine = (await owned(db)).find((t) => t.id === 'research-paper' && t.ownerId === 'u1')!;
    expect(mine.label).toBe('My renamed type');
    expect(mine.language).toBe('python');
    expect((await resolveTreeType(db, 'u1', 'research-paper'))?.label).toBe('My renamed type');
  });

  it('brings a shipped row back to its seed, so a changed type reaches the installs that already have it', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);

    // An install from before the type named its grove agent.
    const shipped = (await db.getTreeTypes()).find((t) => t.id === 'research-paper')!;
    await db.saveTreeType({ ...shipped, agent: undefined });

    expect(await seedTreeTypes(db)).toBe(1);
    expect((await db.getTreeTypes()).find((t) => t.id === 'research-paper')?.agent).toBe('grove-paper');
  });

  it('adds a type shipped later without touching the rest', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedTreeTypes(db);
    await db.deleteTreeType('library', undefined as never);
    const renamed = (await owned(db)).find((t) => t.id === 'dataset')!;
    await db.saveTreeType({ ...renamed, ownerId: 'u1', label: 'Kept' });

    // Only the missing shipped type is written; the person's own row is theirs.
    expect(await seedTreeTypes(db)).toBe(1);

    expect((await owned(db)).find((t) => t.id === 'library')).toBeDefined();
    expect((await owned(db)).find((t) => t.id === 'dataset' && t.ownerId === 'u1')!.label).toBe('Kept');
  });

  it('shows the shipped types to every owner, since they belong to the platform', async () => {
    const db = new MemoryDB();
    await db.init();

    await seedTreeTypes(db);

    // Seeded rows are ownerless now, the same as packs and personas. Copying them per user is what
    // made a changed shipped type reach nobody who already had a copy.
    expect((await owned(db, 'u1')).map((t) => t.id)).toContain('api-service');
    expect((await owned(db, 'u2')).map((t) => t.id)).toContain('api-service');
  });

  it("keeps one owner's OWN types out of another's", async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveTreeType({ id: 'mine', ownerId: 'u1', label: 'Mine', summary: 's' } as never);

    expect((await owned(db, 'u1')).map((t) => t.id)).toContain('mine');
    expect((await owned(db, 'u2')).map((t) => t.id)).not.toContain('mine');
  });
});
