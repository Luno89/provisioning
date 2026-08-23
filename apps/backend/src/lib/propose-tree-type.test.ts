import { describe, it, expect } from 'vitest';
import { MemoryDB } from './memory-db.js';
import { handleProposeTree } from './koala-tool-handlers.js';
import { seedTreeTypes } from './tree-types.js';

/**
 * ── WHAT KOALA MAY CALL A PROJECT ──
 *
 * The type list was a module constant, so the tool schema carried a fixed enum and the handler fell
 * back to `TREE_TYPES[0]` for anything it did not recognise. Both stop working once types are owned
 * records: the enum cannot know a type someone added this morning, and the fallback silently builds
 * the WRONG kind of project — a different image, a different skeleton, a different idea of done.
 *
 * Substituting quietly is the failure mode this codebase avoids everywhere else. Refuse and say what
 * is valid, so the model can correct itself.
 */

const ctx = async () => {
  const db = new MemoryDB();
  await db.init();
  await seedTreeTypes(db, 'u1');
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
    /**
     * The old behaviour picked `TREE_TYPES[0]` — an MCP server — for any unrecognised string. A
     * research request would have come back as a service, with a Dockerfile and a test suite, and
     * nothing said so.
     */
    const out = parse(await handleProposeTree(await ctx(), {
      name: 'A thing', goal: 'Do the thing', type: 'not-a-real-type',
    }));

    expect(out.error).toMatch(/not-a-real-type/);
    // And says what IS valid, structured rather than stuffed into the sentence — the model reads
    // the whole result, and a list it can iterate beats a list it has to parse out of prose.
    expect(out.available.map((t: { id: string }) => t.id)).toContain('library');
  });

  it('refuses rather than defaulting when no type is given at all', async () => {
    // Same reasoning: which kind of project this is decides the image, the skeleton and what
    // finishing means. It is not a field to guess.
    const out = parse(await handleProposeTree(await ctx(), { name: 'A thing', goal: 'Do the thing' }));
    expect(out.error).toMatch(/type/i);
  });

  it('offers a type the owner added themselves', async () => {
    // The whole point of records: a type that exists in no seed still works.
    const c = await ctx() as never as { db: MemoryDB };
    await c.db.saveTreeType({
      id: 'playbook', ownerId: 'u1', label: 'Playbook', summary: 's',
      language: 'node', produces: 'artefact', doneMeans: 'd', files: [],
    });

    const out = parse(await handleProposeTree(c as never, { name: 'A thing', goal: 'g', type: 'playbook' }));
    expect(out.error).toBeUndefined();
  });
});
