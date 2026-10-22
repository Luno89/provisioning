import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../platform/lib/test-database.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { createAccountRemovalActivities, type AccountRemovalDeps } from './RemoveAccountActivities.js';

let db: MongoDB;
let terminated: string[];
let kubectl: string[][];
let deletedUsers: string[];

const deps = (over: Partial<AccountRemovalDeps> = {}): AccountRemovalDeps => ({
  store: db,
  workflows: { stopIfRunning: async (id) => { terminated.push(id); return id === 'run-live'; } },
  kube: async (args) => { kubectl.push(args); return { stdout: 'namespace "koala-run-conversation-c1" deleted', stderr: '', exitCode: 0 }; },
  repositories: { deleteUser: async (username) => { deletedUsers.push(username); return true; } },
  mesh: { removeUser: async () => ({ devices: 0, user: false }) },
  secrets: { removeProject: async () => ({ workspace: true, readers: 1 }) },
  apps: { clusterById: async () => undefined, logFile: () => '/logs/destroy.log', taskQueue: 'cluster-ops-queue' },
  ...over,
});

const seed = async (ownerId: string) => {
  await db.accounts.saveUser({ id: ownerId, email: `${ownerId}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.saveConversation({ id: `${ownerId}-c1`, ownerId, title: 'chat', messages: [], liveTurn: { runId: 'run-live', startedAt: 'then' }, createdAt: 'then', updatedAt: 'then' } as never);
  await db.projects.saveTree({ id: `${ownerId}-t1`, ownerId, name: 'tree', projectIds: [], createdAt: 'then', updatedAt: 'then' } as never);
  await db.memory.saveMemory({ id: `${ownerId}-m1`, ownerId, title: 'm', text: 't', createdAt: 'then', updatedAt: 'then' } as never);
  await db.projects.saveGiteaAccount({ ownerId, username: `koala-${ownerId}`, passwordEnc: 'x', createdAt: 'then' });
  await db.memory.saveMemoryWatermark(`conversation:${ownerId}-c1`, '4');
};

beforeEach(async () => {
  db = await testDatabase();
  terminated = [];
  kubectl = [];
  deletedUsers = [];
  await seed('bo');
  await seed('ana');
});

describe('the steps that remove an account', () => {
  it('stops every workflow it could have running, including the turn still live in a conversation', async () => {
    const stopped = await createAccountRemovalActivities(deps()).RemoveAccountWorkflowsActivity({ ownerId: 'bo' });

    expect(stopped).toBe(1);
    expect(terminated).toEqual(expect.arrayContaining(['bench-idle-bo', 'run-live', 'grove-run-bo-t1', 'conclude-conversation-bo-c1', 'conclude-workspace-conversation-bo-c1']));
    expect(terminated.some((id) => id.includes('ana'))).toBe(false);
  });

  it('stops its projects\' releases and running builds', async () => {
    await db.projects.saveProject({ id: 'bo-shop', name: 'shop', ownerId: 'bo', appType: 'gitapp', createdAt: 'then' });
    await db.releases.savePipelineRun({ id: 'r1', projectId: 'bo-shop', status: 'running', temporalWorkflowId: 'pipeline-r1', startedAt: 'then' } as never);
    await db.releases.savePipelineRun({ id: 'r2', projectId: 'bo-shop', status: 'succeeded', temporalWorkflowId: 'pipeline-r2', startedAt: 'then' } as never);
    await createAccountRemovalActivities(deps()).RemoveAccountWorkflowsActivity({ ownerId: 'bo' });
    expect(terminated).toEqual(expect.arrayContaining(['release-bo-shop', 'pipeline-r1']));
    expect(terminated).not.toContain('pipeline-r2');
  });

  it('plans the destroy of every app it still has, and only its own', async () => {
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-bo', name: 'shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-1a2b3c', ownerId: 'bo', status: 'running' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-ana', name: 'ana-shop', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', ownerId: 'ana', status: 'running' });
    const planned = await createAccountRemovalActivities(deps()).RemoveAccountAppsActivity({ ownerId: 'bo' });
    expect(planned.map((app) => [app.deploymentId, app.args.namespace, app.taskQueue])).toEqual([['odoo-bo', 'shop-1a2b3c', 'cluster-ops-queue']]);
    expect((await db.infrastructure.getDeployments()).map((deployment) => [deployment.id, deployment.status])).toEqual([['odoo-bo', 'destroying'], ['odoo-ana', 'running']]);
  });

  it('deletes its workspaces by their owner label, and takes "none left" as done', async () => {
    const steps = createAccountRemovalActivities(deps());
    await steps.RemoveAccountWorkspacesActivity({ ownerId: 'bo' });
    expect(kubectl[0]).toEqual(['delete', 'namespace', '-l', 'koala.dev/owner=bo', '--wait=true', '--timeout=720h']);

    const none = createAccountRemovalActivities(deps({ kube: async () => ({ stdout: '', stderr: 'No resources found', exitCode: 1 }) }));
    await expect(none.RemoveAccountWorkspacesActivity({ ownerId: 'bo' })).resolves.toBe('');

    const broken = createAccountRemovalActivities(deps({ kube: async () => ({ stdout: '', stderr: 'the server is unreachable', exitCode: 1 }) }));
    await expect(broken.RemoveAccountWorkspacesActivity({ ownerId: 'bo' })).rejects.toThrow('the account\'s workspaces could not be deleted: the server is unreachable');
  });

  it('deletes its Gitea user, and is done when it never had one', async () => {
    const steps = createAccountRemovalActivities(deps());
    expect(await steps.RemoveAccountRepositoriesActivity({ ownerId: 'bo' })).toBe(true);
    expect(deletedUsers).toEqual(['koala-bo']);
    expect(await steps.RemoveAccountRepositoriesActivity({ ownerId: 'nobody' })).toBe(false);
  });

  it('removes every record it owns and leaves everyone else\'s', async () => {
    const removed = await createAccountRemovalActivities(deps()).RemoveAccountRecordsActivity({ ownerId: 'bo' });

    expect(removed).toMatchObject({ conversations: 1, trees: 1, memories: 1, giteaAccounts: 1, memoryWatermarks: 1, users: 1 });
    expect(await db.accounts.getUserById('bo')).toBeUndefined();
    expect(await db.getConversation('bo', 'bo-c1')).toBeUndefined();
    expect(await db.memory.getMemoryWatermark('conversation:bo-c1')).toBeUndefined();
    expect(await db.accounts.getUserById('ana')).toBeDefined();
    expect(await db.getConversation('ana', 'ana-c1')).toBeDefined();
    expect((await db.projects.getTrees()).map((tree) => tree.id)).toEqual(['ana-t1']);
    expect(await db.projects.getGiteaAccount('ana')).not.toBeNull();
    expect(await db.memory.getMemoryWatermark('conversation:ana-c1')).toBe('4');
  });

  it('can run again after it has finished, finding nothing left', async () => {
    const steps = createAccountRemovalActivities(deps());
    await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' });
    expect(await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' })).toEqual({});
  });
});
