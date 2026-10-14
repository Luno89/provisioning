import { describe, it, expect } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { seedAll } from './seed-all.js';

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = new MemoryDB();
    await db.init();

    const { removedBuiltInProcedures, removedBuiltInPersonas, agentToolListsMoved, toolGrantsWritten, builtInCopiesDropped, agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, ...counts } = await seedAll(db as never);
    expect([agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped]).toEqual([0, 0, 0, 0]);
    expect(removedBuiltInProcedures).toBe(0);
    expect(removedBuiltInPersonas).toBe(0);
    expect(agentToolListsMoved).toBe(0);
    expect(toolGrantsWritten).toBe(0);
    expect(builtInCopiesDropped).toBe(0);
    for (const [name, n] of Object.entries(counts)) {
      expect(n, `${name} seeded nothing`).toBeGreaterThan(0);
    }
  });

  it('moves an agent stored with its own tool list onto grants, once', async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveEnginePersona({ slug: 'helper', ownerId: 'user-1', name: 'Helper', tools: ['read_file'] } as never);

    expect(await seedAll(db as never)).toMatchObject({ agentToolListsMoved: 1, toolGrantsWritten: 1 });
    expect(await seedAll(db as never)).toMatchObject({ agentToolListsMoved: 0, toolGrantsWritten: 0 });
    expect((await db.getToolGrants('user-1')).map((grant) => grant.tool)).toEqual(['read_file']);
  });

  it('moves an agent stored with its own list of MCP servers onto server grants, once', async () => {
    const db = new MemoryDB();
    await db.init();
    await db.saveEnginePersona({ slug: 'helper', ownerId: 'user-1', name: 'Helper', mcp: ['gitea'] } as never);

    expect(await seedAll(db as never)).toMatchObject({ agentServerListsMoved: 1 });
    expect(await seedAll(db as never)).toMatchObject({ agentServerListsMoved: 0 });
    expect(await db.getToolGrants('user-1')).toEqual([expect.objectContaining({ agent: 'helper', tool: 'gitea', kind: 'server' })]);
  });

  it('writes nothing on a second run', async () => {
    const db = new MemoryDB();
    await db.init();
    await seedAll(db as never);

    const again = await seedAll(db as never);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
