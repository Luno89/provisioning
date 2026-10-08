import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDB } from '../lib/memory-db.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from './RemoveProjectActivities.js';

let db: MemoryDB;
let terminated: string[];
let kubectl: string[][];
let repos: string[];
let secrets: string[];

const deps = (): ProjectRemovalDeps => ({
  store: db,
  workflows: { stopIfRunning: async (id) => { terminated.push(id); return true; } },
  kube: async (args) => { kubectl.push(args); return { stdout: '', stderr: '', exitCode: 0 }; },
  repositories: { deleteRepo: async (owner, name) => { repos.push(`${owner}/${name}`); } },
  secrets: { removeProject: async (projectId) => { secrets.push(projectId); return { workspace: true, readers: 1 }; } },
});

const at = 'then';

beforeEach(async () => {
  db = new MemoryDB();
  await db.init();
  terminated = [];
  kubectl = [];
  repos = [];
  secrets = [];
  for (const id of ['p1', 'p2']) {
    await db.saveProject({ id, name: `shop-${id}`, ownerId: 'bo', giteaOwner: 'koala-bo', giteaRepo: `shop-${id}`, appType: 'gitapp', createdAt: at });
  }
  await db.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: at });
  await db.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop features', type: 'software', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
  await db.saveTree({ id: 't2', ownerId: 'bo', name: 'Shared', type: 'software', projectIds: ['p2', 'p1'], createdAt: at, updatedAt: at } as never);
  await db.saveBranch({ id: 'b1', ownerId: 'bo', treeId: 't1', title: 'b', createdAt: at, updatedAt: at } as never);
  await db.saveLeaf({ id: 'l1', ownerId: 'bo', branchId: 'b1', title: 'l', status: 'pending', createdAt: at, updatedAt: at } as never);
  await db.saveTask({ id: 'k1', ownerId: 'bo', leafId: 'l1', title: 'k', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.saveTask({ id: 'k2', ownerId: 'bo', projectId: 'p1', title: 'plain', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.saveConversation({ id: 'c1', ownerId: 'bo', treeId: 't1', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.saveConversation({ id: 'c2', ownerId: 'bo', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.savePipelineRun({ id: 'r1', projectId: 'p1', status: 'running', temporalWorkflowId: 'pipeline-r1', startedAt: at } as never);
  await db.savePipelineRun({ id: 'r2', projectId: 'p2', status: 'running', temporalWorkflowId: 'pipeline-r2', startedAt: at } as never);
});

describe('the steps that delete a project', () => {
  it('stops its running builds and its trees\' runs, and no other project\'s', async () => {
    await createProjectRemovalActivities(deps()).RemoveProjectWorkflowsActivity({ projectId: 'p1' });
    expect(terminated).toEqual(['odoo-release-p1', 'pipeline-r1', 'grove-run-t1', 'conclude-workspace-tree-t1']);
  });

  it('deletes its trees\' workspaces and those of their conversations, its secrets, and its repositories', async () => {
    const steps = createProjectRemovalActivities(deps());
    expect(await steps.RemoveProjectWorkspacesActivity({ projectId: 'p1' })).toBe(2);
    expect(kubectl[0]).toEqual(['delete', 'namespace', 'koala-run-tree-t1', 'koala-run-conversation-c1', '--ignore-not-found', '--wait=true', '--timeout=300s']);
    await steps.RemoveProjectSecretsActivity({ projectId: 'p1' });
    expect(secrets).toEqual(['p1']);
    expect(await steps.RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual(['koala-bo/shop-p1', 'koala-bo/tree-t1', 'koala-bo/research-c1']);
  });

  it('deletes its records, unlinks what only mentions it, and leaves the other project whole', async () => {
    const removed = await createProjectRemovalActivities(deps()).RemoveProjectRecordsActivity({ projectId: 'p1' });

    expect(removed).toMatchObject({ trees: 1, branches: 1, leaves: 1, conversations: 1, 'trees unlinked': 1, pipelineRuns: 1, 'conversations unlinked': 1, projects: 1 });
    expect((await db.getProjects()).map((project) => project.id)).toEqual(['p2']);
    expect((await db.getTrees()).map((tree) => [tree.id, tree.projectIds])).toEqual([['t2', ['p2']]]);
    expect((await db.getTasks('bo')).map((task) => task.id)).toEqual([]);
    expect(await db.getConversation('bo', 'c1')).toBeUndefined();
    expect((await db.getConversation('bo', 'c2'))?.projectId).toBeUndefined();
    expect((await db.getPipelineRuns()).map((run) => run.id)).toEqual(['r2']);
  });

  it('finds nothing to do for a project already gone', async () => {
    const steps = createProjectRemovalActivities(deps());
    await steps.RemoveProjectRecordsActivity({ projectId: 'p1' });
    expect(await steps.RemoveProjectRecordsActivity({ projectId: 'p1' })).toEqual({});
    expect(await steps.RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual([]);
  });
});
