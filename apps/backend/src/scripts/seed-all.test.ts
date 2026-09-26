import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { seedAll } from './seed-all.js';

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = new MemoryDB();
    await db.init();

    const { removedBuiltInProcedures, removedBuiltInPersonas, ...counts } = await seedAll(db as never);
    expect(removedBuiltInProcedures).toBe(0);
    expect(removedBuiltInPersonas).toBe(0);
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
});
