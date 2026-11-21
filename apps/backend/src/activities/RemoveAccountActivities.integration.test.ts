import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { Readable } from 'node:stream';
import { storedFilesOn } from '../files/testing/stored-files-twin.js';
import { indexingFrom, indexMemories } from '../memory/lib/memory-index.js';
import { MEMORY_COLLECTION, MEMORY_INDEX } from '../memory/lib/memory-rank.js';
import { startCorpusStandIn } from '../engine/testing/corpus-stand-in.js';
import { createAccountRemovalActivities, type AccountRemovalDeps } from './RemoveAccountActivities.js';

const fresh = await emptiedEachTime();
const standIn = await startCorpusStandIn();
afterAll(async () => { await standIn.stop(); });

let db: MongoDB;
let kubectl: string[][];
let deletedUsers: string[];

const deps = (over: Partial<AccountRemovalDeps> = {}): AccountRemovalDeps => ({
  store: db,
  work: { open: async () => [], handle: () => { throw new Error('this file stops no workflow'); }, decode: async () => [] },
  projects: { purge: async () => undefined },
  kube: async (args) => { kubectl.push(args); return { stdout: 'namespace "koala-run-conversation-c1" deleted', stderr: '', exitCode: 0 }; },
  repositories: { deleteUser: async (username) => { deletedUsers.push(username); return true; } },
  mesh: { removeUser: async () => ({ devices: 0, user: false }) },
  secrets: { removeProject: async () => ({ workspace: true, readers: 1 }) },
  files: storedFilesOn(db.files).files,
  apps: { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/logs/destroy.log', taskQueue: 'cluster-ops-queue' },
  memoryIndex: indexingFrom(standIn.reach),
  ...over,
});

const seed = async (ownerId: string) => {
  await db.accounts.saveUser({ id: ownerId, email: `${ownerId}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: 'then' });
  await db.engine.saveConversation({ id: `${ownerId}-c1`, ownerId, title: 'chat', messages: [], liveTurn: { runId: 'run-live', startedAt: 'then' }, createdAt: 'then', updatedAt: 'then' } as never);
  await db.projects.saveTree({ id: `${ownerId}-t1`, ownerId, name: 'tree', projectIds: [], createdAt: 'then', updatedAt: 'then' } as never);
  await db.memory.saveMemory({ id: `${ownerId}-m1`, ownerId, title: 'm', text: 't', createdAt: 'then', updatedAt: 'then' } as never);
  await db.projects.saveGiteaAccount({ ownerId, username: `koala-${ownerId}`, passwordEnc: 'x', createdAt: 'then' });
  await db.memory.saveMemoryWatermark(`conversation:${ownerId}-c1`, '4');
  await db.machines.saveMachineJoinCode({ hash: `${ownerId}-join`, id: `${ownerId}-join`, ownerId, expiresAt: '2026-01-01T00:00:00.000Z', progress: { stage: 'k3s', title: 'Installing k3s', state: 'failed', why: 'no space left', at: '2026-01-01T00:00:00.000Z' } });
};

beforeEach(async () => {
  db = await fresh();
  kubectl = [];
  deletedUsers = [];
  await seed('bo');
  await seed('ana');
});

describe('the steps that remove an account', () => {
  it('finds every project of its own to delete, and none of anyone else\'s', async () => {
    await db.projects.saveProject({ id: 'bo-shop', name: 'shop', ownerId: 'bo', appType: 'gitapp', createdAt: 'then' });
    await db.projects.saveProject({ id: 'ana-shop', name: 'shop', ownerId: 'ana', appType: 'gitapp', createdAt: 'then' });
    expect(await createAccountRemovalActivities(deps()).RemoveAccountProjectsActivity({ ownerId: 'bo' })).toEqual(['bo-shop']);
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

    expect(removed).toMatchObject({ conversations: 1, trees: 1, memories: 1, giteaAccounts: 1, memoryWatermarks: 1, machineJoinCodes: 1, users: 1 });
    expect(await db.machines.getReportedMachineJoins('bo')).toEqual([]);
    expect((await db.machines.getReportedMachineJoins('ana')).map((join) => join.id)).toEqual(['ana-join']);
    expect(await db.accounts.getUserById('bo')).toBeUndefined();
    expect(await db.engine.getConversation('bo', 'bo-c1')).toBeUndefined();
    expect(await db.memory.getMemoryWatermark('conversation:bo-c1')).toBeUndefined();
    expect(await db.accounts.getUserById('ana')).toBeDefined();
    expect(await db.engine.getConversation('ana', 'ana-c1')).toBeDefined();
    expect((await db.projects.getTrees()).map((tree) => tree.id)).toEqual(['ana-t1']);
    expect(await db.projects.getGiteaAccount('ana')).not.toBeNull();
    expect(await db.memory.getMemoryWatermark('conversation:ana-c1')).toBe('4');
  });

  it('takes the account\'s memories out of the index with their records, and leaves everyone else\'s', async () => {
    const [bo, ana] = [...await db.memory.getMemories('bo'), ...await db.memory.getMemories('ana')];
    await indexMemories(standIn.reach, [bo!, ana!]);

    await createAccountRemovalActivities(deps()).RemoveAccountRecordsActivity({ ownerId: 'bo' });

    expect(standIn.documents(MEMORY_INDEX).map((doc) => doc.memory_id)).toEqual(['ana-m1']);
    expect(standIn.points(MEMORY_COLLECTION).map((point) => point.memory_id)).toEqual(['ana-m1']);
  });

  it('removes every file the account keeps, in every place, and leaves everyone else\'s', async () => {
    const { files, objects } = storedFilesOn(db.files);
    for (const [owner, scope, path] of [['bo', { kind: 'project', id: 'p1' }, 'a.pdf'], ['bo', { kind: 'person', id: 'bo' }, 'b.txt'], ['bo', { kind: 'run', id: 'r1' }, 'shot.png'], ['ana', { kind: 'person', id: 'ana' }, 'c.txt']] as const) {
      const kept = await files.at(owner, scope).upload(path, Readable.from([Buffer.from('x')]), 1, 'text/plain', { replace: true });
      if (!kept.ok) throw new Error(kept.why);
    }
    const removed = await createAccountRemovalActivities(deps({ files })).RemoveAccountRecordsActivity({ ownerId: 'bo' });
    expect(removed).toMatchObject({ storedFiles: 3 });
    expect(await db.files.storedFilesOwnedBy('bo')).toEqual([]);
    expect((await db.files.storedFilesOwnedBy('ana')).map((record) => record.path)).toEqual(['c.txt']);
    expect(objects.kept.size).toBe(1);
  });

  it('can run again after it has finished, finding nothing left', async () => {
    const steps = createAccountRemovalActivities(deps());
    await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' });
    expect(await steps.RemoveAccountRecordsActivity({ ownerId: 'bo' })).toEqual({});
  });
});
