import { describe, it, expect } from 'vitest';
import { testDatabase } from '../platform/lib/test-database.js';
import { seedAll } from './seed-all.js';

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = await testDatabase();

    const { removedBuiltInProcedures, removedBuiltInPersonas, agentToolListsMoved, toolGrantsWritten, builtInCopiesDropped, agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade, ...counts } = await seedAll(db);
    expect([agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade]).toEqual([0, 0, 0, 0, 0, 0, 0]);
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
    const db = await testDatabase();
    await db.engine.saveEnginePersona({ slug: 'helper', ownerId: 'user-1', name: 'Helper', tools: ['read_file'] } as never);

    expect(await seedAll(db)).toMatchObject({ agentToolListsMoved: 1, toolGrantsWritten: 1 });
    expect(await seedAll(db)).toMatchObject({ agentToolListsMoved: 0, toolGrantsWritten: 0 });
    expect((await db.engine.getToolGrants('user-1')).map((grant) => grant.tool)).toEqual(['read_file']);
  });

  it('moves an agent stored with its own list of MCP servers onto server grants, once', async () => {
    const db = await testDatabase();
    await db.engine.saveEnginePersona({ slug: 'helper', ownerId: 'user-1', name: 'Helper', mcp: ['gitea'] } as never);

    expect(await seedAll(db)).toMatchObject({ agentServerListsMoved: 1 });
    expect(await seedAll(db)).toMatchObject({ agentServerListsMoved: 0 });
    expect(await db.engine.getToolGrants('user-1')).toEqual([expect.objectContaining({ agent: 'helper', tool: 'gitea', kind: 'server' })]);
  });

  it('writes nothing on a second run', async () => {
    const db = await testDatabase();
    await seedAll(db);

    const again = await seedAll(db);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
