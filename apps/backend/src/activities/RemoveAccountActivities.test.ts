import { MockActivityEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { KubeResult, KubeRunner } from '../engine-host/sandboxes/kube.js';
import type { Database } from '../platform/lib/db-interface.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { createAccountRemovalActivities, type AccountRemovalActivities, type AccountRemovalDeps } from './RemoveAccountActivities.js';

type Workflows = AccountRemovalDeps['workflows'];
type Repositories = AccountRemovalDeps['repositories'];
type Mesh = AccountRemovalDeps['mesh'];
type Secrets = AccountRemovalDeps['secrets'];
type Accounts = AccountRemovalDeps['store']['accounts'];

const BO_IDS = { runIds: ['run-live'], treeIds: ['bo-t1'], conversationIds: ['bo-c1'], proposalIds: ['prop-1'], projectIds: ['bo-shop', 'bo-blog'], buildWorkflowIds: ['pipeline-r1'], ingestIds: ['ing-1'] };

let db: Database;
let workflows: ReturnType<typeof mock<Workflows>>;
let kube: ReturnType<typeof mockFn<KubeRunner>>;
let repositories: ReturnType<typeof mock<Repositories>>;
let mesh: ReturnType<typeof mock<Mesh>>;
let accounts: ReturnType<typeof mock<Accounts>>;
let secrets: ReturnType<typeof mock<Secrets>>;

const done = (over: Partial<KubeResult> = {}): KubeResult => ({ stdout: 'namespace "koala-run-conversation-c1" deleted', stderr: '', exitCode: 0, ...over });

const steps = (over: Partial<AccountRemovalDeps> = {}): AccountRemovalActivities => createAccountRemovalActivities({
  store: { accounts, projects: db.projects, engine: db.engine, infrastructure: db.infrastructure },
  workflows,
  kube,
  repositories,
  mesh,
  secrets,
  apps: { clusterById: async () => undefined, logFile: () => '/logs/destroy.log', taskQueue: 'cluster-ops-queue' },
  ...over,
});

beforeEach(async () => {
  db = memoryDatabase();
  workflows = mock<Workflows>();
  workflows.stopIfRunning.mockImplementation(async (id) => id === 'run-live');
  kube = mockFn<KubeRunner>();
  kube.mockResolvedValue(done());
  repositories = mock<Repositories>();
  repositories.deleteUser.mockResolvedValue(true);
  mesh = mock<Mesh>();
  mesh.removeUser.mockResolvedValue({ devices: 2, user: true });
  secrets = mock<Secrets>();
  secrets.removeProject.mockResolvedValue({ workspace: true, readers: 1 });
  accounts = mock<Accounts>();
  accounts.accountIds.calledWith('bo').mockResolvedValue(BO_IDS);
  accounts.accountIds.calledWith('nobody').mockResolvedValue({ runIds: [], treeIds: [], conversationIds: [], proposalIds: [], projectIds: [], buildWorkflowIds: [], ingestIds: [] });
  await db.projects.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: 'then' });
});

describe('the steps that remove an account', () => {
  it('stops every workflow it could have running, including the turn still live in a conversation', async () => {
    const stopped = await steps().RemoveAccountWorkflowsActivity({ ownerId: 'bo' });

    expect(stopped).toBe(1);
    const asked = workflows.stopIfRunning.mock.calls.map(([id]) => id);
    expect(asked).toEqual(expect.arrayContaining([
      'bench-idle-bo', 'run-live', 'grove-run-bo-t1', 'conclude-conversation-bo-c1', 'conclude-workspace-conversation-bo-c1', 'release-bo-shop', 'release-bo-blog', 'pipeline-r1',
    ]));
    expect(workflows.stopIfRunning).toHaveBeenCalledWith('run-live', 'the account was removed');
  });

  it('stops them in batches and heartbeats after each', async () => {
    const many = Array.from({ length: 45 }, (_, index) => `build-${index}`);
    accounts.accountIds.calledWith('bo').mockResolvedValue({ ...BO_IDS, buildWorkflowIds: many });
    const env = new MockActivityEnvironment();
    let beats = 0;
    env.on('heartbeat', () => { beats += 1; });
    await env.run(() => steps().RemoveAccountWorkflowsActivity({ ownerId: 'bo' }));
    expect(workflows.stopIfRunning.mock.calls.length).toBeGreaterThan(45);
    expect(beats).toBe(Math.ceil(workflows.stopIfRunning.mock.calls.length / 20));
  });

  it('hands its runs over to another account when asked to keep them', async () => {
    await db.engine.saveRunEffort({
      runId: 'run-1', ownerId: 'bo', agentSlug: 'koala', procedureId: 'chat', procedureVersion: '1', modelKey: 'k', modelLabel: 'l', outcome: 'ok', rounds: 1, toolCalls: 0, totalTokens: 1,
      childRuns: 0, longestReply: 1, cappedAt: 0, steps: 1, wallClockMs: 1, ask: 'a', limits: {} as never, finishedAt: 't',
    });
    expect(await steps().RemoveAccountKeepRunsActivity({ ownerId: 'bo', keepRunsFor: 'ana' })).toBe(1);
    expect((await db.engine.findRunEffort('run-1'))?.ownerId).toBe('ana');
  });

  it('plans the destroy of every app it still has, and only its own', async () => {
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-bo', name: 'shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-1a2b3c', ownerId: 'bo', status: 'running' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-ana', name: 'ana-shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', ownerId: 'ana', status: 'running' });
    const planned = await steps().RemoveAccountAppsActivity({ ownerId: 'bo' });
    expect(planned.map((app) => [app.deploymentId, app.args.namespace, app.taskQueue])).toEqual([['odoo-bo', 'shop-1a2b3c', 'cluster-ops-queue']]);
    expect((await db.infrastructure.getDeployments()).map((deployment) => [deployment.id, deployment.status])).toEqual([['odoo-bo', 'destroying'], ['odoo-ana', 'running']]);
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

  it('removes every record it owns, naming the conversations\' watermarks, the ingests and the projects that go with them', async () => {
    accounts.removeAccountRecords.mockResolvedValue({ conversations: 1, users: 1 });
    expect(await steps().RemoveAccountRecordsActivity({ ownerId: 'bo' })).toEqual({ conversations: 1, users: 1 });
    expect(accounts.removeAccountRecords).toHaveBeenCalledWith('bo', { watermarkKeys: ['conversation:bo-c1'], ingestIds: ['ing-1'], projectIds: ['bo-shop', 'bo-blog'] });
  });
});
