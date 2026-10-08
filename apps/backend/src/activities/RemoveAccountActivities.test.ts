import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { createAccountRemovalActivities, type AccountRemovalDeps } from './RemoveAccountActivities.js';

let db: MemoryDB;
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
  ...over,
});

const seed = async (ownerId: string) => {
  await db.saveUser({ id: ownerId, email: `${ownerId}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.saveConversation({ id: `${ownerId}-c1`, ownerId, title: 'chat', messages: [], liveTurn: { runId: 'run-live', startedAt: 'then' }, createdAt: 'then', updatedAt: 'then' } as never);
  await db.saveTree({ id: `${ownerId}-t1`, ownerId, name: 'tree', projectIds: [], createdAt: 'then', updatedAt: 'then' } as never);
  await db.saveMemory({ id: `${ownerId}-m1`, ownerId, title: 'm', text: 't', createdAt: 'then', updatedAt: 'then' } as never);
  await db.saveGiteaAccount({ ownerId, username: `koala-${ownerId}`, passwordEnc: 'x', createdAt: 'then' });
  await db.saveMemoryWatermark(`conversation:${ownerId}-c1`, '4');
};

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
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

  it('deletes its workspaces by their owner label, and takes "none left" as done', async () => {
    const steps = createAccountRemovalActivities(deps());
    await steps.RemoveAccountWorkspacesActivity({ ownerId: 'bo' });
    expect(kubectl[0]).toEqual(['delete', 'namespace', '-l', 'koala.dev/owner=bo', '--wait=true', '--timeout=300s']);

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
    expect(await db.getUserById('bo')).toBeUndefined();
    expect(await db.getConversation('bo', 'bo-c1')).toBeUndefined();
    expect(await db.getMemoryWatermark('conversation:bo-c1')).toBeUndefined();
    expect(await db.getUserById('ana')).toBeDefined();
    expect(await db.getConversation('ana', 'ana-c1')).toBeDefined();
    expect((await db.getTrees()).map((tree) => tree.id)).toEqual(['ana-t1']);
    expect(await db.getGiteaAccount('ana')).not.toBeNull();
    expect(await db.getMemoryWatermark('conversation:ana-c1')).toBe('4');
  });

  it('can run again after it has finished, finding nothing left', async () => {
    const steps = createAccountRemovalActivities(deps());
    await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' });
    expect(await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' })).toEqual({});
  });
});
