import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { handleProposeTree } from './koala-tool-handlers.js';
import { seedTreeTypes } from './tree-types.js';

const ctx = async () => {
  const db = new MemoryDB();
  await db.init();
  await seedTreeTypes(db);
  await db.saveConversation({ id: 'c1', ownerId: 'u1', messages: [] } as never);
  return { db, userId: 'u1', conversationId: 'c1', sessionId: 's1', servers: [] } as never;
};

const parse = (result: { content?: string }) => JSON.parse(String(result.content ?? '{}'));

describe('proposing a tree of some type', () => {
  it('accepts a type the owner has', async () => {
    const out = parse(await handleProposeTree(await ctx(), {
      name: 'A thing', goal: 'Do the thing', type: 'library',
    }));
    expect(out.error).toBeUndefined();
    expect(out.proposed?.type ?? out.type).toBe('library');
  });

  it('REFUSES an unknown type instead of quietly building another kind', async () => {
    const out = parse(await handleProposeTree(await ctx(), {
      name: 'A thing', goal: 'Do the thing', type: 'not-a-real-type',
    }));

    expect(out.error).toMatch(/not-a-real-type/);
    expect(out.available.map((t: { id: string }) => t.id)).toContain('library');
  });

  it('refuses rather than defaulting when no type is given at all', async () => {
    const out = parse(await handleProposeTree(await ctx(), { name: 'A thing', goal: 'Do the thing' }));
    expect(out.error).toMatch(/type/i);
  });

  it('offers a type the owner added themselves', async () => {
    const c = await ctx() as never as { db: MemoryDB };
    await c.db.saveTreeType({
      id: 'playbook', ownerId: 'u1', label: 'Playbook', summary: 's',
      language: 'node', produces: 'artefact', doneMeans: 'd', files: [],
    });

    const out = parse(await handleProposeTree(c as never, { name: 'A thing', goal: 'g', type: 'playbook' }));
    expect(out.error).toBeUndefined();
  });
});
