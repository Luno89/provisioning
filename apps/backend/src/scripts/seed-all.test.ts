import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { seedAll } from './seed-all.js';

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = new MemoryDB();
    await db.init();

    expect(await db.getTools()).toEqual([]);
    expect(await db.getPersonas()).toEqual([]);
    expect(await db.getPersonaPacks()).toEqual([]);

    const counts = await seedAll(db as never);
    for (const [name, n] of Object.entries(counts)) {
      expect(n, `${name} seeded nothing`).toBeGreaterThan(0);
    }
  });

  it('writes nothing on a second run', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedAll(db as never);

    const again = await seedAll(db as never);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('seeds personas before packs, since a pack whose persona is absent is skipped', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedAll(db as never);

    const personas = await db.getPersonas();
    for (const pack of await db.getPersonaPacks()) {
      expect(personas.find((p) => p.id === pack.personaId), `${pack.slug} points at nothing`).toBeDefined();
    }
  });
});
