import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { leaseMongo } from '../platform/lib/mongo-lease.js';
import { describe, it, expect, inject } from 'vitest';
import { looksEncrypted } from '../platform/lib/crypto.js';
import { MongoDB } from '../platform/lib/mongo-db.js';
import { TEST_DATA_KEY, testDatabase } from '../platform/lib/test-database.js';
import { seedAll } from './seed-all.js';
import { mongoTarget } from '../platform/lib/mongo-target.js';

const SEED_KEY = TEST_DATA_KEY;

async function onItsOwnDatabase(body: (db: MongoDB, raw: Db) => Promise<void>): Promise<void> {
  const name = `t_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const db = new MongoDB({ mongo: mongoTarget({ MONGO_URI: `${inject('mongoUri')}${name}` }), dataKey: SEED_KEY });
  const { client, release } = await leaseMongo(inject('mongoUri'));
  try {
    await db.init();
    await body(db, client.db(name));
  } finally {
    await db.dropDatabase();
    await db.close();
    await release();
  }
}

describe('seed-all', () => {
  it('fills every catalogue the platform expects to find in the database', async () => {
    const db = await testDatabase();

    const { removedBuiltInProcedures, removedBuiltInPersonas, agentHandOffListsMoved, handOffGrantsWritten, agentToolListsMoved, toolGrantsWritten, builtInCopiesDropped, agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade, releasesMarkedTold, deploymentSecretsSealed, inviteCodesHashed, clientFilesForgotten, shareTokensSealed, unkeptAttachmentsDropped, clusterProvidersDropped, githubCredentialsDropped, joinTokensDropped, vllmLatestPinned, approveAskDropped, ...counts } = await seedAll(db);
    expect(approveAskDropped).toBe(0);
    expect(clusterProvidersDropped).toBe(0);
    expect(vllmLatestPinned).toBe(0);
    expect(githubCredentialsDropped).toBe(0);
    expect(joinTokensDropped).toBe(0);
    expect(unkeptAttachmentsDropped).toBe(0);
    expect([agentServerListsMoved, servingToolsMoved, mcpToolKindsMoved, treeVersionsStamped, toolsNamingNeeds, serversNamingNeeds, dependenciesMade, releasesMarkedTold, deploymentSecretsSealed, inviteCodesHashed, clientFilesForgotten, shareTokensSealed]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(removedBuiltInProcedures).toBe(0);
    expect(removedBuiltInPersonas).toBe(0);
    expect(agentToolListsMoved).toBe(0);
    expect(toolGrantsWritten).toBe(0);
    expect([agentHandOffListsMoved, handOffGrantsWritten]).toEqual([0, 0]);
    expect(builtInCopiesDropped).toBe(0);
    for (const [name, n] of Object.entries(counts)) {
      expect(n, `${name} seeded nothing`).toBeGreaterThan(0);
    }
  });

  it('takes, once, the old ask setting off the approve node of every saved procedure', async () => {
    const db = await testDatabase();
    const source = (ask: string | undefined) => JSON.stringify({ schema: 2, id: 'mine', start: 'approve', nodes: [{ id: 'approve', kind: 'approve-tool-calls', settings: ask ? { ask } : {}, position: { x: 0, y: 0 } }], wires: [], flow: [], groups: [] });
    await db.engine.saveProcedure({ id: 'mine', ownerId: 'ann', version: '1', source: source('never'), updatedAt: 'then' });

    expect(await seedAll(db)).toMatchObject({ approveAskDropped: 1 });
    expect((JSON.parse((await db.engine.getProcedure('ann', 'mine'))!.source) as { nodes: { settings: unknown }[] }).nodes[0]!.settings).toEqual({});
    await db.engine.saveProcedure({ id: 'mine', ownerId: 'ann', version: '2', source: source('always'), updatedAt: 'later' });
    expect(await seedAll(db)).toMatchObject({ approveAskDropped: 0 });
  });

  it('drops, once, every chat attachment that names a path and no kept file, keeping the message', async () => {
    const db = await testDatabase();
    const at = '2026-01-01T00:00:00.000Z';
    const kept = { fileId: 'f1', name: 'brief.pdf' };
    await db.engine.saveConversation({ id: 'chat', ownerId: 'ann', title: 'A chat', createdAt: at, updatedAt: at, messages: [
      { role: 'user', content: 'see these', at, attachments: [kept, { name: 'old.pdf', path: 'attachments/old.pdf' } as never] },
      { role: 'user', content: 'and this', at, attachments: [{ name: 'gone.png', path: 'chats/gone.png' } as never] },
    ] });

    expect(await seedAll(db)).toMatchObject({ unkeptAttachmentsDropped: 1 });
    await db.engine.appendMessage('ann', 'chat', { role: 'user', content: 'later', at, attachments: [{ name: 'after.pdf', path: 'a.pdf' } as never] });
    expect(await seedAll(db)).toMatchObject({ unkeptAttachmentsDropped: 0 });
    expect((await db.engine.getConversation('ann', 'chat'))?.messages).toEqual([
      { role: 'user', content: 'see these', at, attachments: [kept] },
      { role: 'user', content: 'and this', at },
      { role: 'user', content: 'later', at, attachments: [{ name: 'after.pdf', path: 'a.pdf' }] },
    ]);
  });

  it('forgets every GitHub token saved under Cloud providers once, keeping the other credentials', async () => {
    const db = await testDatabase();
    await db.accounts.saveUser({ id: 'ann', email: 'ann@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', credentials: { github: { token: 'sealed' }, huggingface: { hfToken: 'sealed-hf' } } } as never);

    expect(await seedAll(db)).toMatchObject({ githubCredentialsDropped: 1 });
    expect(await seedAll(db)).toMatchObject({ githubCredentialsDropped: 0 });
    expect((await db.accounts.getUserById('ann'))?.credentials).toEqual({ huggingface: { hfToken: 'sealed-hf' } });
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

  it('moves an agent stored with its own list of agents it hands work to onto hand-off grants, once, keeping its tool list for the tool move', async () => {
    const db = await testDatabase();
    await db.engine.saveEnginePersona({ slug: 'helper', ownerId: 'user-1', name: 'Helper', agents: ['research'], tools: ['read_file'] } as never);

    expect(await seedAll(db)).toMatchObject({ agentHandOffListsMoved: 1, handOffGrantsWritten: 1, agentToolListsMoved: 1, toolGrantsWritten: 1 });
    expect(await seedAll(db)).toMatchObject({ agentHandOffListsMoved: 0, handOffGrantsWritten: 0 });
    expect((await db.engine.getToolGrants('user-1')).map((grant) => [grant.tool, grant.kind ?? 'tool'])).toEqual(expect.arrayContaining([['research', 'agent'], ['read_file', 'tool']]));
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
    await onItsOwnDatabase(async (db, raw) => {
      const deployments = raw.collection('deployments');
      await deployments.insertOne({ _id: 'old' as never, name: 'files', clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'bo', minioRootPassword: 'from-before' });

      expect(await seedAll(db)).toMatchObject({ deploymentSecretsSealed: 1 });
      expect(looksEncrypted(String((await deployments.findOne({ _id: 'old' as never }))?.minioRootPassword))).toBe(true);
      expect((await db.infrastructure.getDeployments()).find((d) => d.id === 'old')?.minioRootPassword).toBe('from-before');
      expect(await seedAll(db)).toMatchObject({ deploymentSecretsSealed: 0 });
    });
  });

  it('forgets which files a project shared with its clients, now that clients see every file, once', async () => {
    await onItsOwnDatabase(async (db, raw) => {
      const projects = raw.collection('projects');
      await projects.insertMany([
        { _id: 'shared' as never, name: 'Shop', ownerId: 'bo', createdAt: '2026-10-01T00:00:00.000Z', clientFiles: ['designs'] },
        { _id: 'plain' as never, name: 'Blog', ownerId: 'bo', createdAt: '2026-10-01T00:00:00.000Z' },
      ]);

      expect(await seedAll(db)).toMatchObject({ clientFilesForgotten: 1 });
      expect(await projects.countDocuments({ clientFiles: { $exists: true } })).toBe(0);
      expect(await projects.countDocuments({})).toBe(2);
      expect(await seedAll(db)).toMatchObject({ clientFilesForgotten: 0 });
    });
  });

  it('writes nothing on a second run', async () => {
    const db = await testDatabase();
    await seedAll(db);

    const again = await seedAll(db);
    expect(Object.values(again).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('keeps vLLM\'s tool call parsers as they ship on every start, and every parser added another way', async () => {
    const db = await testDatabase();
    await db.models.saveToolCallParser({ parser: 'my-own', label: 'Mine', template: [{ contains: '<mine>' }], names: [], shipped: false });
    expect((await seedAll(db)).toolCallParsers).toBe(54);
    const hermes = (await db.models.getToolCallParsers()).find((row) => row.parser === 'hermes')!;
    await db.models.saveToolCallParser({ ...hermes, label: 'changed by hand', template: [] });
    await db.models.saveToolCallParser({ ...hermes, parser: 'no-longer-shipped' });

    expect((await seedAll(db)).toolCallParsers).toBe(2);
    const rows = await db.models.getToolCallParsers();
    expect(rows.find((row) => row.parser === 'hermes')).toEqual(hermes);
    expect(rows.find((row) => row.parser === 'my-own')).toEqual({ parser: 'my-own', label: 'Mine', template: [{ contains: '<mine>' }], names: [], shipped: false });
    expect(rows.map((row) => row.parser)).not.toContain('no-longer-shipped');
    expect(rows).toHaveLength(55);
  });

  it('drops the cluster providers Koala kept before it stopped making clusters, once, keeping everything else', async () => {
    await onItsOwnDatabase(async (db, raw) => {
      await raw.collection('clusterProviders').insertMany([{ _id: 'k3d' as never }, { _id: 'hetzner' as never }, { _id: 'digitalocean' as never }]);
      await raw.collection('clusters').insertOne({ _id: 'machine-desk' as never, name: 'desk', provider: 'machine', status: 'stopped' });

      expect(await seedAll(db)).toMatchObject({ clusterProvidersDropped: 3 });
      expect(await raw.listCollections({ name: 'clusterProviders' }).toArray()).toEqual([]);
      expect((await db.infrastructure.getClusters()).map((cluster) => cluster.id)).toEqual(['machine-desk']);
      expect(await seedAll(db)).toMatchObject({ clusterProvidersDropped: 0 });
    });
  });

  it('drops the join tokens install.sh used before Koala came to a machine only through its join, once, keeping the instances', async () => {
    await onItsOwnDatabase(async (db, raw) => {
      await raw.collection('instanceJoinTokens').insertMany([{ _id: 'a' as never, ownerId: 'ann', instanceId: 'inst-ann' }, { _id: 'b' as never, ownerId: 'bo', instanceId: 'inst-bo', move: true }]);
      await db.instances.saveInstance({ id: 'inst-ann', ownerId: 'ann', url: 'https://ann.example', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });

      expect(await seedAll(db)).toMatchObject({ joinTokensDropped: 2 });
      expect(await raw.listCollections({ name: 'instanceJoinTokens' }).toArray()).toEqual([]);
      expect((await db.instances.getInstances()).map((instance) => instance.id)).toEqual(['inst-ann']);
      expect(await seedAll(db)).toMatchObject({ joinTokensDropped: 0 });
    });
  });
});
