import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { seedAll } from '../scripts/seed-all.js';
import { withBuiltIns } from './ownership.js';
import { resolveTreeType } from './tree-types.js';
import { visibleAppSpecs } from './app-spec.js';
import { ToolService } from '../services/ToolService.js';
import { packForLeaf } from './packs.js';

const fresh = async () => {
  const db = new MemoryDB();
  await db.init();
  await seedAll(db as never);
  return db;
};

describe('every per-user catalogue comes from the database', () => {
  it('serves a shipped row that was CHANGED in the database, not the seed constant', async () => {
    const db = await fresh();

    const tree = (await db.getTreeTypes()).find((t) => t.id === 'api-service')!;
    await db.saveTreeType({ ...tree, label: 'changed in db' } as never);
    expect((await resolveTreeType(db, 'u1', 'api-service'))?.label).toBe('changed in db');

    const tool = (await db.getTools()).find((t) => t.name === 'get_logs')!;
    await db.saveTool({ ...tool, description: 'changed in db' });
    expect((await new ToolService(db).list('u1')).find((t) => t.name === 'get_logs')!.description)
      .toBe('changed in db');
  });

  it('keeps one tenant out of another, for every catalogue that has an owner', async () => {
    const db = await fresh();

    await db.saveTool({ ...(await db.getTools())[0]!, id: 'their-tool', ownerId: 'u2', name: 'get_logs', description: 'theirs' });
    await db.saveTreeType({ id: 'api-service', ownerId: 'u2', label: 'theirs', summary: 's' } as never);
    await db.savePersona({ id: 'their-persona', ownerId: 'u2', name: 'Koala', systemPrompt: 'theirs', createdAt: '', updatedAt: '' } as never);
    // A user cannot shadow a shipped spec — chat-pack refuses an id that ships with the platform —
    // so their own specs carry their own ids, and the filter is what keeps them apart.
    await db.saveAppSpec({ id: 'their-app', spec: {} as never, builtIn: false, ownerId: 'u2', createdAt: '', updatedAt: '' });

    expect((await new ToolService(db).list('u1')).find((t) => t.name === 'get_logs')!.description)
      .not.toBe('theirs');
    expect((await resolveTreeType(db, 'u1', 'api-service'))?.label).not.toBe('theirs');
    expect(withBuiltIns(await db.getPersonas(), 'u1', (p) => p.name).find((p) => p.name === 'Koala')!.systemPrompt)
      .not.toBe('theirs');
    expect(visibleAppSpecs(await db.getAppSpecs(), 'u1').map((s) => s.id)).not.toContain('their-app');
    expect(visibleAppSpecs(await db.getAppSpecs(), 'u2').map((s) => s.id)).toContain('their-app');
  });

  it('lets a user replace a shipped row for themselves alone', async () => {
    const db = await fresh();
    const koala = (await db.getPersonaPacks()).find((p) => p.slug === 'koala')!;
    await db.savePersonaPack({ ...koala, id: 'mine', ownerId: 'u1', name: 'My Koala' });

    const mine = withBuiltIns(await db.getPersonaPacks(), 'u1', (p) => p.slug);
    const theirs = withBuiltIns(await db.getPersonaPacks(), 'u2', (p) => p.slug);
    expect(mine.find((p) => p.slug === 'koala')!.name).toBe('My Koala');
    expect(theirs.find((p) => p.slug === 'koala')!.name).toBe('Koala');
  });
});

describe('a built-in is visible from every place that reads one', () => {
  /**
   * ExecuteLeafActivity filtered `ownerId === leaf.ownerId`, so once seeded rows became ownerless
   * it saw 0 of 9 packs and every leaf ran with no pack, no persona, no checkout and no egress
   * rules. It did not crash, which is why nothing caught it. `resolveTreeType` had the same bug an
   * hour earlier: an ownership filter written before built-ins were ownerless.
   *
   * So this asserts the property rather than any one call site — a hand-written `=== ownerId`
   * anywhere fails here.
   */
  it('leaves no hand-written owner comparison on a catalogue that has built-ins', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const here = path.dirname(new URL(import.meta.url).pathname);
    const roots = [path.join(here, '..', 'activities'), path.join(here, '..', 'routes'), here];

    const offenders: string[] = [];
    const scan = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
        const src = fs.readFileSync(full, 'utf8');
        for (const call of ['getPersonaPacks()', 'getPersonas()', 'getTools()']) {
          const at = src.indexOf(call);
          if (at < 0) continue;
          const line = src.slice(at, src.indexOf('\n', at));
          // `withBuiltIns` and `ownedBy` are the two sanctioned readers; a raw `.filter` on ownerId
          // is the shape that silently drops every shipped row.
          if (/\.filter\(.*ownerId ===/.test(line)) offenders.push(`${entry.name}: ${line.trim()}`);
        }
      }
    };
    for (const r of roots) if (fs.existsSync(r)) scan(r);

    expect(offenders, `these drop ownerless built-ins:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('lets a leaf resolve a shipped pack it was never given a copy of', async () => {
    const db = await fresh();
    const packs = withBuiltIns(await db.getPersonaPacks(), 'u1', (p) => p.slug);
    expect(packs.length).toBeGreaterThan(0);
    expect(packForLeaf(packs, { packId: 'builder' })?.slug).toBe('builder');
  });
});
