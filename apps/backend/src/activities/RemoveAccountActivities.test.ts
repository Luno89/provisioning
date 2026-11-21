import { testIdentityKey } from '../platform/testing/keys.js';
import { MockActivityEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { KubeResult, KubeRunner } from '../engine-host/sandboxes/kube.js';
import type { Database } from '../platform/lib/db-interface.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { roleFromEnv, type RoleConfig } from '../platform/index.js';
import { createAccountRemovalActivities, removalMeshFor, type AccountRemovalActivities, type AccountRemovalDeps } from './RemoveAccountActivities.js';

type Repositories = AccountRemovalDeps['repositories'];
type Mesh = AccountRemovalDeps['mesh'];
type Secrets = AccountRemovalDeps['secrets'];
type Files = AccountRemovalDeps['files'];

const at = 'then';

let db: Database;
let kube: ReturnType<typeof mockFn<KubeRunner>>;
let repositories: ReturnType<typeof mock<Repositories>>;
let mesh: ReturnType<typeof mock<Mesh>>;
let secrets: ReturnType<typeof mock<Secrets>>;
let files: ReturnType<typeof mock<Files>>;

const done = (over: Partial<KubeResult> = {}): KubeResult => ({ stdout: 'namespace "koala-run-conversation-c1" deleted', stderr: '', exitCode: 0, ...over });

const steps = (over: Partial<AccountRemovalDeps> = {}): AccountRemovalActivities => createAccountRemovalActivities({
  store: { accounts: db.accounts, projects: db.projects, engine: db.engine, files: db.files, memory: db.memory, infrastructure: db.infrastructure },
  memoryIndex: { unindex: async () => undefined },
  now: () => Date.parse('2026-11-13T10:00:00.000Z'),
  work: mock<AccountRemovalDeps['work']>(),
  projects: { purge: async () => undefined },
  kube,
  repositories,
  mesh,
  secrets,
  files,
  apps: { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/logs/destroy.log', taskQueue: 'cluster-ops-queue' },
  ...over,
});

beforeEach(async () => {
  db = memoryDatabase();
  kube = mockFn<KubeRunner>();
  kube.mockResolvedValue(done());
  repositories = mock<Repositories>();
  repositories.deleteUser.mockResolvedValue(true);
  mesh = mock<Mesh>();
  mesh.removeUser.mockResolvedValue({ devices: 2, user: true });
  secrets = mock<Secrets>();
  secrets.removeProject.mockResolvedValue({ workspace: true, readers: 1 });
  files = mock<Files>();
  files.removeOwned.mockResolvedValue(0);
  await db.accounts.saveUser({ id: 'bo', email: 'bo@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: at });
  await db.accounts.saveUser({ id: 'ana', email: 'ana@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: at });
  await db.projects.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: at });
  await db.engine.saveConversation({ id: 'bo-c1', ownerId: 'bo', title: 'chat', messages: [], liveTurn: { runId: 'run-live', startedAt: at }, createdAt: at, updatedAt: at } as never);
  await db.engine.saveConversation({ id: 'ana-c1', ownerId: 'ana', title: 'chat', messages: [], createdAt: at, updatedAt: at } as never);
  await db.projects.saveTree({ id: 'bo-t1', ownerId: 'bo', name: 'tree', projectIds: [], createdAt: at, updatedAt: at } as never);
  await db.projects.savePlanProposal({ id: 'prop-1', ownerId: 'bo', conversationId: 'bo-c1', createdAt: at } as never);
  for (const id of ['bo-shop', 'bo-blog']) await db.projects.saveProject({ id, name: id, ownerId: 'bo', appType: 'gitapp', createdAt: at });
  await db.releases.savePipelineRun({ id: 'r1', projectId: 'bo-shop', status: 'running', temporalWorkflowId: 'pipeline-r1', startedAt: at } as never);
  await db.releases.savePipelineRun({ id: 'r2', projectId: 'bo-shop', status: 'succeeded', temporalWorkflowId: 'pipeline-r2', startedAt: at } as never);
  await db.engine.saveCorpusPages([{ id: 'page-1', ownerId: 'bo', ingestId: 'ing-1', url: 'https://example.com', host: 'example.com', text: 't', bytes: 1, fetchedAt: at }]);
  await db.memory.saveMemoryWatermark('conversation:bo-c1', '4');
  await db.memory.saveMemoryWatermark('conversation:ana-c1', '4');
});

describe('the steps that remove an account', () => {
  it('marks the account being removed as a check\'s space never was, once, in the step', async () => {
    await steps().MarkAccountRemovingActivity({ ownerId: 'bo', keepRunsFor: 'ana' });
    expect((await db.accounts.getUserById('bo'))?.removal).toEqual({ startedAt: '2026-11-13T10:00:00.000Z', requestedBy: 'ana' });
  });

  it('keeps the mark a removal asked from Settings already set', async () => {
    await db.accounts.saveUser({ ...(await db.accounts.getUserById('bo'))!, removal: { startedAt: 'earlier', requestedBy: 'bo' } });
    await steps().MarkAccountRemovingActivity({ ownerId: 'bo' });
    expect((await db.accounts.getUserById('bo'))?.removal).toEqual({ startedAt: 'earlier', requestedBy: 'bo' });
  });

  it('cancels every open workflow Temporal lists as the account\'s, but not its own removal, and says which it stopped', async () => {
    const asked: string[] = [];
    const cancelled: string[] = [];
    const work = mock<AccountRemovalDeps['work']>();
    work.open.mockImplementation(async (query) => { asked.push(query); return [{ workflowId: 'run-live', type: 'AgentRunWorkflow', startedAt: at }, { workflowId: 'done-already', type: 'AgentRunWorkflow', startedAt: at }]; });
    work.handle.mockImplementation((workflowId) => ({
      describe: async () => ({ status: { name: workflowId === 'run-live' ? 'RUNNING' : 'COMPLETED' } }),
      cancel: async () => { cancelled.push(workflowId); },
      result: async () => undefined,
      history: async () => [],
    }));
    expect(await steps({ work }).StopAccountWorkActivity({ ownerId: 'bo' })).toEqual([{ workflowId: 'run-live', type: 'AgentRunWorkflow', startedAt: at }]);
    expect(asked).toEqual(['KoalaOwner = "bo" AND ExecutionStatus = "Running" AND WorkflowId != "remove-account-bo"']);
    expect(cancelled).toEqual(['run-live']);
  });

  it('deletes each of its projects for good, the ones in Deleted projects too, through the project\'s own deletion', async () => {
    await db.projects.markDeleting('bo-blog', { startedAt: at, requestedBy: 'bo', mode: 'archive' });
    await db.projects.archive('bo-blog');
    expect((await steps().RemoveAccountProjectsActivity({ ownerId: 'bo' })).sort()).toEqual(['bo-blog', 'bo-shop']);
    const purge = mockFn<AccountRemovalDeps['projects']['purge']>().mockResolvedValue(undefined);
    await steps({ projects: { purge } }).DeleteAccountProjectActivity({ ownerId: 'bo', projectId: 'bo-blog' });
    expect(purge).toHaveBeenCalledExactlyOnceWith('bo-blog', 'bo');
  });

  it('hands its runs over to another account when asked to keep them', async () => {
    await db.engine.saveRunEffort({
      runId: 'run-1', ownerId: 'bo', agentSlug: 'koala', procedureId: 'chat', procedureVersion: '1', modelKey: 'k', modelLabel: 'l', outcome: 'ok', rounds: 1, toolCalls: 0, totalTokens: 1,
      childRuns: 0, longestReply: 1, cappedAt: 0, steps: 1, wallClockMs: 1, ask: 'a', limits: {} as never, finishedAt: 't',
    });
    await db.files.beginStoredFile({ id: 'shot', objectId: 'shot', ownerId: 'bo', scope: { kind: 'run', id: 'run-1' }, path: 'shot.png', kind: 'file', size: 0, contentType: 'image/png', version: 0, madeAt: at, changedAt: at, state: 'uploading', touchedAt: at });
    expect(await steps().RemoveAccountKeepRunsActivity({ ownerId: 'bo', keepRunsFor: 'ana' })).toBe(2);
    expect((await db.engine.findRunEffort('run-1'))?.ownerId).toBe('ana');
    expect((await db.files.storedFileById('shot'))?.ownerId).toBe('ana');
  });

  it('plans the destroy of every app it still has, and only its own', async () => {
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-bo', name: 'shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-1a2b3c', ownerId: 'bo', status: 'running' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-ana', name: 'ana-shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', ownerId: 'ana', status: 'running' });
    const planned = await steps().RemoveAccountAppsActivity({ ownerId: 'bo' });
    expect(planned.map((app) => [app.deploymentId, app.args.namespace, app.taskQueue])).toEqual([['odoo-bo', 'shop-1a2b3c', 'cluster-ops-queue']]);
    expect((await db.infrastructure.getDeployments()).map((deployment) => [deployment.id, deployment.status, deployment.temporalWorkflowId ?? ''])).toEqual([['odoo-bo', 'destroying', ''], ['odoo-ana', 'running', '']]);
    await steps().RemoveAccountAppStartedActivity({ deploymentId: 'odoo-bo', workflowId: planned[0]!.workflowId });
    expect((await db.infrastructure.getDeployments()).find((deployment) => deployment.id === 'odoo-bo')?.temporalWorkflowId).toBe(planned[0]!.workflowId);
  });

  it('plans nothing for an account with no apps', async () => {
    expect(await steps().RemoveAccountAppsActivity({ ownerId: 'bo' })).toEqual([]);
  });

  it('deletes its workspaces by their owner label, and takes "none left" as done', async () => {
    await steps().RemoveAccountWorkspacesActivity({ ownerId: 'bo' });
    expect(kube).toHaveBeenCalledWith(['delete', 'namespace', '-l', 'koala.dev/owner=bo', '--wait=true', '--timeout=720h']);

    kube.mockResolvedValue(done({ stdout: '', stderr: 'No resources found', exitCode: 1 }));
    await expect(steps().RemoveAccountWorkspacesActivity({ ownerId: 'bo' })).resolves.toBe('');

    kube.mockResolvedValue(done({ stdout: '', stderr: 'the server is unreachable', exitCode: 1 }));
    await expect(steps().RemoveAccountWorkspacesActivity({ ownerId: 'bo' })).rejects.toThrow('the account\'s workspaces could not be deleted: the server is unreachable');
  });

  it('removes the secrets of each of its projects and counts the workspaces and readers that went', async () => {
    secrets.removeProject.mockReset();
    secrets.removeProject.calledWith('bo-shop').mockResolvedValue({ workspace: true, readers: 1 });
    secrets.removeProject.calledWith('bo-blog').mockResolvedValue({ workspace: false, readers: 3 });
    const env = new MockActivityEnvironment();
    expect(await env.run(() => steps().RemoveAccountSecretsActivity({ ownerId: 'bo' }))).toBe(5);
    expect(secrets.removeProject).toHaveBeenCalledTimes(2);
    expect(secrets.removeProject).toHaveBeenCalledWith('bo-shop');
  });

  it('removes its mesh user and devices', async () => {
    expect(await steps().RemoveAccountMeshActivity({ ownerId: 'bo' })).toEqual({ devices: 2, user: true });
    expect(mesh.removeUser).toHaveBeenCalledWith('bo');
  });

  it('deletes its Gitea user, and is done when it never had one', async () => {
    expect(await steps().RemoveAccountRepositoriesActivity({ ownerId: 'bo' })).toBe(true);
    expect(repositories.deleteUser).toHaveBeenCalledWith('koala-bo');
    expect(await steps().RemoveAccountRepositoriesActivity({ ownerId: 'nobody' })).toBe(false);
    expect(repositories.deleteUser).toHaveBeenCalledTimes(1);
  });

  it('removes every record it owns, with the conversations\' watermarks, the ingests and the projects\' builds that go with them, and leaves everyone else\'s', async () => {
    const removed = await steps().RemoveAccountRecordsActivity({ ownerId: 'bo' });

    expect(removed).toMatchObject({ users: 1, conversations: 1, trees: 1, planProposals: 1, projects: 2, giteaAccounts: 1, corpus: 1, memoryWatermarks: 1, pipelineRuns: 2 });
    expect(await db.accounts.getUserById('bo')).toBeUndefined();
    expect(await db.engine.getConversation('bo', 'bo-c1')).toBeUndefined();
    expect(await db.memory.getMemoryWatermark('conversation:bo-c1')).toBeUndefined();
    expect(await db.releases.getPipelineRuns()).toEqual([]);
    expect(await db.accounts.getUserById('ana')).toBeDefined();
    expect(await db.engine.getConversation('ana', 'ana-c1')).toBeDefined();
    expect(await db.memory.getMemoryWatermark('conversation:ana-c1')).toBe('4');
    expect(await db.accounts.accountLeftovers('bo')).toEqual({});
    expect(files.removeOwned).toHaveBeenCalledExactlyOnceWith('bo');
  });

  it('removes every file the account keeps, counted with its records', async () => {
    files.removeOwned.mockResolvedValue(3);
    expect(await steps().RemoveAccountRecordsActivity({ ownerId: 'bo' })).toMatchObject({ storedFiles: 3, users: 1 });
    expect(files.removeOwned).toHaveBeenCalledExactlyOnceWith('bo');
  });

  it('can run again after it has finished, finding nothing left', async () => {
    await steps().RemoveAccountRecordsActivity({ ownerId: 'bo' });
    expect(await steps().RemoveAccountRecordsActivity({ ownerId: 'bo' })).toEqual({});
  });
});

describe('the mesh a removal clears', () => {
  const headscale = (): Mesh => ({ removeUser: async () => ({ devices: 2, user: true }) });

  it('is Headscale where accounts are held', async () => {
    expect(await removalMeshFor(roleFromEnv({ ROLE: 'root', ROOT_IDENTITY_KEY: testIdentityKey() }), headscale).removeUser('u1')).toEqual({ devices: 2, user: true });
  });

  it("is none on an instance, whose people are on root's mesh, so no Headscale is reached", async () => {
    let reached = false;
    const instance: RoleConfig = { role: 'instance', instance: { id: 'inst-1', ownerId: 'u1', rootUrl: 'http://root.test' } };
    const mesh = removalMeshFor(instance, () => { reached = true; return headscale(); });
    expect(await mesh.removeUser('space-1')).toEqual({ devices: 0, user: false });
    expect(reached).toBe(false);
  });
});
