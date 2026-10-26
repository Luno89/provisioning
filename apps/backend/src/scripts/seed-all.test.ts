import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { describe, it, expect, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { MongoDB } from '../platform/lib/mongo-db.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { seedAll } from './seed-all.js';

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = await testDatabase();

    const { removedBuiltInProcedures, removedBuiltInPersonas, agentToolListsMoved, toolGrantsWritten, builtInCopiesDropped, agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade, releasesMarkedTold, deploymentSecretsSealed, inviteCodesHashed, ...counts } = await seedAll(db);
    expect([agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade, releasesMarkedTold, deploymentSecretsSealed, inviteCodesHashed]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(removedBuiltInProcedures).toBe(0);
    expect(removedBuiltInPersonas).toBe(0);
    expect(agentToolListsMoved).toBe(0);
    expect(toolGrantsWritten).toBe(0);
    expect(builtInCopiesDropped).toBe(0);
    for (const [name, n] of Object.entries(counts)) {
      expect(n, `${name} seeded nothing`).toBeGreaterThan(0);
    }
  });

  it('keeps only a hash of every invite code already stored, and gives an unused one two weeks from now', async () => {
    const db = await testDatabase();
    await db.accounts.saveInvite({ id: 'old', code: 'OLDCODE', createdBy: 'ann', createdAt: '2026-01-01T00:00:00.000Z' });
    await db.accounts.saveInvite({ id: 'spent', code: 'SPENT', createdBy: 'ann', createdAt: '2026-01-01T00:00:00.000Z', usedBy: 'bo', usedAt: '2026-01-02T00:00:00.000Z' });

    expect(await seedAll(db)).toMatchObject({ inviteCodesHashed: 2 });
    expect(await seedAll(db)).toMatchObject({ inviteCodesHashed: 0 });
    const stored = await db.accounts.getInvites();
    expect(stored.some((invite) => invite.code !== undefined)).toBe(false);
    expect((await db.accounts.getInviteByCode('OLDCODE'))?.expiresAt).toBeDefined();
    expect((await db.accounts.getInviteByCode('SPENT'))).toMatchObject({ usedBy: 'bo' });
    expect((await db.accounts.getInviteByCode('SPENT'))?.expiresAt).toBeUndefined();
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

  it('marks every release from before releases recorded what was told as told, once', async () => {
    const db = await testDatabase();
    await db.releases.saveOdooRelease({ id: 'r1', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b1', commit: 'aaa', image: 'img', state: 'live', host: 'shop', startedAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:05:00.000Z' });
    await db.releases.saveOdooRelease({ id: 'r2', ownerId: 'bo', projectId: 'p1', pipelineRunId: 'b2', commit: 'bbb', image: 'img2', state: 'preview', host: 'shop', startedAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:05:00.000Z', toldAt: '2026-10-02T00:00:00.000Z' });

    expect(await seedAll(db)).toMatchObject({ releasesMarkedTold: 1 });
    expect((await db.releases.getOdooReleases('bo', 'p1')).map((release) => [release.id, release.toldAt])).toEqual([['r2', '2026-10-02T00:00:00.000Z'], ['r1', '2026-10-01T00:05:00.000Z']]);
    expect(await seedAll(db)).toMatchObject({ releasesMarkedTold: 0 });
  });

  it('seals every deployment secret stored plain before sealing, once, and reads it back plain', async () => {
    const name = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const db = new MongoDB({ MONGO_URI: `${inject('mongoUri')}${name}` });
    const client = await MongoClient.connect(inject('mongoUri'));
    try {
      await db.init();
      const deployments = client.db(name).collection('deployments');
      await deployments.insertOne({ _id: 'old' as never, name: 'files', clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'bo', minioRootPassword: 'from-before' });

      expect(await seedAll(db)).toMatchObject({ deploymentSecretsSealed: 1 });
      expect(looksEncrypted(String((await deployments.findOne({ _id: 'old' as never }))?.minioRootPassword))).toBe(true);
      expect((await db.infrastructure.getDeployments()).find((d) => d.id === 'old')?.minioRootPassword).toBe('from-before');
      expect(await seedAll(db)).toMatchObject({ deploymentSecretsSealed: 0 });
    } finally {
      await db.dropDatabase();
      await db.close();
      await client.close();
    }
  });

  it('writes nothing on a second run', async () => {
    const db = await testDatabase();
    await seedAll(db);

    const again = await seedAll(db);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
  });
});
