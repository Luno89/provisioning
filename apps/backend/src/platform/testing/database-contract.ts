import { describe, expect, it } from 'vitest';
import type { Database } from '../lib/db-interface.js';

const at = new Date().toISOString();
const later = new Date('2099-01-01T00:00:00.000Z');

interface World {
  owner: string;
  project: string;
  tree: string;
  conversation: string;
  run: string;
  liveRun: string;
  ingest: string;
}

const worldOf = (owner: string): World => ({
  owner,
  project: `project-${owner}`,
  tree: `tree-${owner}`,
  conversation: `chat-${owner}`,
  run: `run-${owner}`,
  liveRun: `live-${owner}`,
  ingest: `ingest-${owner}`,
});

async function seed(db: Database, world: World): Promise<void> {
  const { owner, project, tree, conversation, run, liveRun, ingest } = world;
  await db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, createdAt: at } as never);
  await db.accounts.savePasswordReset({ id: `reset-${owner}`, ownerId: owner, codeHash: 'hash', expiresAt: later, wrong: 0, sent: 1 } as never);
  await db.accounts.saveTwoFactorCode({ id: `code-${owner}`, ownerId: owner, codeHash: 'hash', expiresAt: later });
  await db.projects.saveProject({ id: project, ownerId: owner, name: project, giteaOwner: '', giteaRepo: '', appType: 'gitapp', createdAt: at } as never);
  await db.projects.saveTree({ id: tree, ownerId: owner, name: tree, createdAt: at, updatedAt: at } as never);
  await db.projects.savePlanProposal({ id: `proposal-${owner}`, ownerId: owner, conversationId: conversation, createdAt: at } as never);
  await db.projects.saveTask({ id: `task-${owner}`, ownerId: owner, projectId: project, treeId: tree } as never);
  await db.projects.saveSecretRequest({ id: `secret-${owner}`, ownerId: owner, projectId: project, key: 'KEY', createdAt: at } as never);
  await db.projects.saveGiteaAccount({ ownerId: owner, username: owner, password: 'x' } as never);
  await db.engine.saveConversation({ id: conversation, ownerId: owner, projectId: project, title: 'Talk', messages: [], liveTurn: { runId: liveRun }, createdAt: at, updatedAt: at } as never);
  await db.engine.appendTurnLog({ turnId: run, ownerId: owner, seq: 1, events: [], at });
  await db.engine.saveRunEffort({ runId: run, ownerId: owner, agentSlug: 'koala', procedureId: 'chat', procedureVersion: '1', modelKey: 'm', modelLabel: 'm', outcome: 'finished', rounds: 1, toolCalls: 0, totalTokens: 1, childRuns: 0, longestReply: 1, cappedAt: 0, steps: 1, wallClockMs: 1, ask: 'hi', limits: {}, startedAt: at, finishedAt: at } as never);
  await db.engine.saveCorpusPages([{ id: `page-${owner}`, ownerId: owner, ingestId: ingest, projectId: project, url: 'https://example.com', host: 'example.com', text: 'text', bytes: 4, fetchedAt: at }]);
  await db.engine.enqueueFrontier([{ id: `url-${owner}`, ingestId: ingest, url: 'https://example.com/a', depth: 0, rank: 0, state: 'pending' }]);
  await db.engine.saveAutoModeSettings({ ownerId: owner, agents: {} } as never);
  await db.releases.savePipelineRun({ id: `build-${owner}`, projectId: project, status: 'running', temporalWorkflowId: `build-workflow-${owner}`, createdAt: at } as never);
  await db.releases.saveOdooRelease({ id: `release-${owner}`, projectId: project, ownerId: owner } as never);
  await db.files.saveFileShare({ id: `share-${owner}`, token: `token-${owner}`, ownerId: owner, projectId: project, path: 'a.txt', name: 'a.txt', createdAt: at, expiresAt: later.toISOString() });
  await db.files.beginStoredFile({ id: `file-${owner}`, objectId: `file-${owner}`, ownerId: owner, scope: { kind: 'run', id: run }, path: 'a.txt', kind: 'file', size: 0, contentType: 'text/plain', version: 0, madeAt: at, changedAt: at, state: 'uploading', touchedAt: at });
  await db.infrastructure.savePendingApproval({ id: `approval-${owner}`, ownerId: owner, projectId: project, createdAt: at } as never);
  await db.infrastructure.saveCluster({ id: `cluster-${owner}`, ownerId: owner, name: `cluster-${owner}`, provider: 'k3d', status: 'destroyed' } as never);
  await db.memory.saveMemory({ id: `memory-${owner}`, ownerId: owner, projectId: project, text: 'kept' } as never);
  await db.memory.saveKeeperSettings({ ownerId: owner } as never);
  await db.memory.saveKeepingState({ ownerId: owner, state: 'kept', at });
  await db.memory.saveMemoryWatermark(`conversation:${conversation}`, at);
  await db.monitoring.saveNotificationSettings({ ownerId: owner, level: 'all' } as never);
  await db.monitoring.saveAlertRule({ id: `rule-${owner}`, ownerId: owner } as never);
  await db.models.saveModelEndpoint({ id: `endpoint-${owner}`, ownerId: owner, name: 'model' } as never);
  await db.machines.saveLocalAgentDevice({ id: `device-${owner}`, ownerId: owner, name: 'laptop' } as never);
  await db.instances.saveInstance({ id: `instance-${owner}`, ownerId: owner, name: `inst${owner.replace(/\W/g, '')}`, createdAt: at } as never);
  await db.instances.oidcUpsert('Grant', `grant-${owner}`, { accountId: owner });
}

const ONE_ACCOUNT: Record<string, number> = {
  autoModeSettings: 1,
  clusters: 1,
  conversations: 1,
  corpus: 1,
  fileShares: 1,
  giteaAccounts: 1,
  instances: 1,
  keeperSettings: 1,
  localAgentDevices: 1,
  memories: 1,
  memoryKeeping: 1,
  modelEndpoints: 1,
  monitoringAlertRules: 1,
  notificationSettings: 1,
  odooReleases: 1,
  passwordResets: 1,
  pendingApprovals: 1,
  planProposals: 1,
  projects: 1,
  secretRequests: 1,
  storedFiles: 1,
  tasks: 1,
  trees: 1,
  turnLogs: 1,
  twoFactorCodes: 1,
  users: 1,
  engineRunEffort: 1,
};

export function databaseContract(make: () => Promise<Database>): void {

  describe('one account, one project and its runs across every area', () => {
    const related = (world: World) => ({
      watermarkKeys: [`conversation:${world.conversation}`],
      ingestIds: [world.ingest],
      projectIds: [world.project],
    });

    it('finds an account\'s ids and leftovers in every area that holds them', async () => {
      const db = await make();
      const one = worldOf('owner-1');
      await seed(db, one);
      await seed(db, worldOf('owner-2'));
      const ids = await db.accounts.accountIds('owner-1');
      expect({ ...ids, runIds: [...ids.runIds].sort() }).toEqual({
        runIds: [one.liveRun, one.run].sort(),
        treeIds: [one.tree],
        conversationIds: [one.conversation],
        proposalIds: ['proposal-owner-1'],
        projectIds: [one.project],
        buildWorkflowIds: ['build-workflow-owner-1'],
        ingestIds: [one.ingest],
      });
      expect(await db.accounts.accountLeftovers('owner-1')).toEqual(ONE_ACCOUNT);
      expect(await db.accounts.accountIds('nobody')).toEqual({ runIds: [], treeIds: [], conversationIds: [], proposalIds: [], projectIds: [], buildWorkflowIds: [], ingestIds: [] });
    });

    it('removes an account\'s records from every area and leaves another account\'s alone', async () => {
      const db = await make();
      const one = worldOf('owner-1');
      const two = worldOf('owner-2');
      await seed(db, one);
      await seed(db, two);
      const removed = await db.accounts.removeAccountRecords('owner-1', related(one));
      expect(removed).toEqual({ ...ONE_ACCOUNT, memoryWatermarks: 1, crawl_frontier: 1, pipelineRuns: 1, oidcArtifacts: 1 });
      expect(await db.accounts.accountLeftovers('owner-1')).toEqual({});
      expect(await db.accounts.accountLeftovers('owner-2')).toEqual(ONE_ACCOUNT);
      expect(await db.accounts.getUserById('owner-1')).toBeUndefined();
      expect(await db.accounts.getUserById('owner-2')).toMatchObject({ id: 'owner-2' });
      expect(await db.engine.getConversation('owner-1', one.conversation)).toBeUndefined();
      expect(await db.engine.getConversation('owner-2', two.conversation)).toMatchObject({ id: two.conversation });
      expect(await db.engine.countFrontier(one.ingest)).toBe(0);
      expect(await db.engine.countFrontier(two.ingest)).toBe(1);
      expect(await db.memory.getMemoryWatermark(`conversation:${one.conversation}`)).toBeUndefined();
      expect(await db.memory.getMemoryWatermark(`conversation:${two.conversation}`)).toBe(at);
      expect((await db.releases.getPipelineRuns()).map((run) => run.id)).toEqual(['build-owner-2']);
      expect(await db.instances.oidcFind('Grant', 'grant-owner-1')).toBeUndefined();
      expect(await db.instances.oidcFind('Grant', 'grant-owner-2')).toBeDefined();
      expect(await db.accounts.removeAccountRecords('owner-1', { watermarkKeys: [], ingestIds: [], projectIds: [] })).toEqual({});
    });

    it('removes a project\'s records from every area and unlinks the conversations and memories that named it', async () => {
      const db = await make();
      const one = worldOf('owner-1');
      const two = worldOf('owner-2');
      await seed(db, one);
      await seed(db, two);
      expect(await db.projects.removeProjectRecords(one.project)).toEqual({
        pipelineRuns: 1,
        odooReleases: 1,
        corpus: 1,
        secretRequests: 1,
        pendingApprovals: 1,
        tasks: 1,
        'conversations unlinked': 1,
        'memories unlinked': 1,
        projects: 1,
      });
      expect(await db.engine.getConversation('owner-1', one.conversation)).toMatchObject({ id: one.conversation });
      expect((await db.engine.getConversation('owner-1', one.conversation)) as unknown as Record<string, unknown>).not.toHaveProperty('projectId');
      expect((await db.memory.getMemories('owner-1'))[0]).not.toHaveProperty('projectId');
      expect((await db.engine.getConversation('owner-2', two.conversation))).toMatchObject({ projectId: two.project });
      expect((await db.memory.getMemories('owner-2'))[0]).toMatchObject({ projectId: two.project });
      expect((await db.projects.getProjects()).map((project) => project.id)).toEqual([two.project]);
      expect((await db.releases.getPipelineRuns()).map((run) => run.id)).toEqual(['build-owner-2']);
      expect(await db.engine.getCorpusPages({ ownerId: 'owner-1' })).toEqual([]);
      expect(await db.engine.getCorpusPages({ ownerId: 'owner-2' })).toHaveLength(1);
      expect(await db.infrastructure.getPendingApprovals()).toHaveLength(1);
      expect(await db.projects.removeProjectRecords(one.project)).toEqual({});
    });

    it('moves a run\'s turn log with the rest of the run, and its files through the files area', async () => {
      const db = await make();
      const one = worldOf('owner-1');
      await seed(db, one);
      expect(await db.engine.reownRuns('owner-1', 'owner-1', [one.run])).toBe(0);
      expect(await db.engine.reownRuns('owner-1', 'owner-2', [])).toBe(0);
      expect(await db.engine.reownRuns('owner-1', 'owner-2', [one.run])).toBe(2);
      expect(await db.engine.getTurnLog('owner-2', one.run, 0)).toHaveLength(1);
      expect(await db.files.reownRunFiles('owner-1', 'owner-2', [one.run])).toBe(1);
      expect((await db.files.storedFileById(`file-${one.owner}`))?.ownerId).toBe('owner-2');
    });
  });
}
