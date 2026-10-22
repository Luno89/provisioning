import { describe, it, expect, beforeEach } from 'vitest';
import { testDatabase } from '../platform/lib/test-database.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from './RemoveProjectActivities.js';
import { ArtifactService } from '../files/services/ArtifactService.js';

let db: MongoDB;
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
  apps: {
    clusterById: async (id) => (id === 'system' ? { id: 'system', name: 'provisioning-lunorica', provider: 'k3d', status: 'running' } as never : undefined),
    logFile: () => '/logs/destroy.log',
    taskQueue: 'cluster-ops-queue',
  },
});

const at = 'then';

beforeEach(async () => {
  db = await testDatabase();
  terminated = [];
  kubectl = [];
  repos = [];
  secrets = [];
  for (const id of ['p1', 'p2']) {
    await db.projects.saveProject({ id, name: `shop-${id}`, ownerId: 'bo', giteaOwner: 'koala-bo', giteaRepo: `shop-${id}`, appType: 'gitapp', createdAt: at });
  }
  await db.projects.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: at });
  await db.projects.saveTree({ id: 't1', ownerId: 'bo', name: 'Shop features', type: 'software', projectIds: ['p1'], createdAt: at, updatedAt: at } as never);
  await db.projects.saveTree({ id: 't2', ownerId: 'bo', name: 'Shared', type: 'software', projectIds: ['p2', 'p1'], createdAt: at, updatedAt: at } as never);
  await db.projects.saveBranch({ id: 'b1', ownerId: 'bo', treeId: 't1', title: 'b', createdAt: at, updatedAt: at } as never);
  await db.projects.saveLeaf({ id: 'l1', ownerId: 'bo', branchId: 'b1', title: 'l', status: 'pending', createdAt: at, updatedAt: at } as never);
  await db.projects.saveTask({ id: 'k1', ownerId: 'bo', leafId: 'l1', title: 'k', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.projects.saveTask({ id: 'k2', ownerId: 'bo', projectId: 'p1', title: 'plain', doneMeans: 'x', dependsOn: [], status: 'accepted', runs: [], createdAt: at, updatedAt: at });
  await db.engine.saveConversation({ id: 'c1', ownerId: 'bo', treeId: 't1', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.engine.saveConversation({ id: 'c2', ownerId: 'bo', projectId: 'p1', messages: [], createdAt: at, updatedAt: at } as never);
  await db.releases.savePipelineRun({ id: 'r1', projectId: 'p1', status: 'running', temporalWorkflowId: 'pipeline-r1', startedAt: at } as never);
  await db.releases.savePipelineRun({ id: 'r2', projectId: 'p2', status: 'running', temporalWorkflowId: 'pipeline-r2', startedAt: at } as never);
});

describe('the steps that delete a project', () => {
  it('stops its running builds and its trees\' runs, and no other project\'s', async () => {
    await createProjectRemovalActivities(deps()).RemoveProjectWorkflowsActivity({ projectId: 'p1' });
    expect(terminated).toEqual(['release-p1', 'pipeline-r1', 'grove-run-t1', 'conclude-workspace-tree-t1']);
  });

  it('deletes its trees\' workspaces and those of their conversations, its secrets, and its repositories', async () => {
    const steps = createProjectRemovalActivities(deps());
    expect(await steps.RemoveProjectWorkspacesActivity({ projectId: 'p1' })).toBe(2);
    expect(kubectl[0]).toEqual(['delete', 'namespace', 'koala-run-tree-t1', 'koala-run-conversation-c1', '--ignore-not-found', '--wait=true', '--timeout=720h']);
    await steps.RemoveProjectSecretsActivity({ projectId: 'p1' });
    expect(secrets).toEqual(['p1']);
    expect(await steps.RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual(['koala-bo/shop-p1', 'koala-bo/tree-t1', 'koala-bo/research-c1']);
  });

  it('deletes its files on its file server, and does nothing for a project that never kept any', async () => {
    const removed: string[] = [];
    const files = { removeAll: async (ownerId: string, place: { folder: string }) => { removed.push(`${ownerId}:${place.folder}`); return 'removed' as const; } };
    await db.projects.saveProjectInfo({ id: 'p1', files: { kind: 'minio', deploymentId: 'm1', folder: 'shop' } } as never);
    const steps = createProjectRemovalActivities({ ...deps(), files });
    expect(await steps.RemoveProjectFilesActivity({ projectId: 'p1' })).toBe('removed');
    expect(await steps.RemoveProjectFilesActivity({ projectId: 'p2' })).toBe('none');
    expect(removed).toEqual(['bo:shop']);
  });

    it('deletes its records, unlinks what only mentions it, and leaves the other project whole', async () => {
    const removed = await createProjectRemovalActivities(deps()).RemoveProjectRecordsActivity({ projectId: 'p1' });

    expect(removed).toMatchObject({ trees: 1, branches: 1, leaves: 1, conversations: 1, 'trees unlinked': 1, pipelineRuns: 1, 'conversations unlinked': 1, projects: 1 });
    expect((await db.projects.getProjects()).map((project) => project.id)).toEqual(['p2']);
    expect((await db.projects.getTrees()).map((tree) => [tree.id, tree.projectIds])).toEqual([['t2', ['p2']]]);
    expect((await db.projects.getTasks('bo')).map((task) => task.id)).toEqual([]);
    expect(await db.engine.getConversation('bo', 'c1')).toBeUndefined();
    expect((await db.engine.getConversation('bo', 'c2'))?.projectId).toBeUndefined();
    expect((await db.releases.getPipelineRuns()).map((run) => run.id)).toEqual(['r2']);
  });

  it('removes what its releases\' browser tests kept, and nothing of another project\'s', async () => {
    const artifacts = new ArtifactService({ records: db.files, minioFor: async () => undefined });
    for (const [id, projectId] of [['rel1', 'p1'], ['rel2', 'p2']] as const) {
      await db.releases.saveOdooRelease({ id, ownerId: 'bo', projectId, pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'preview', host: 'h', startedAt: at, updatedAt: at });
      await artifacts.put('bo', id, [{ name: 'shot.png', bytes: Buffer.from('png') }]);
    }
    const removed = await createProjectRemovalActivities({ ...deps(), artifacts }).RemoveProjectRecordsActivity({ projectId: 'p1' });
    expect(removed).toMatchObject({ artifacts: 1, odooReleases: 1 });
    expect(await artifacts.list('bo', 'rel1')).toEqual([]);
    expect((await artifacts.list('bo', 'rel2')).map((artifact) => artifact.name)).toEqual(['shot.png']);
  });

  it('plans the destroy of each app built from it, on the app\'s own cluster and namespace, and deletes the app\'s record with the rest', async () => {
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-p1', name: 'shop-p1', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-p1-1a2b3c', ownerId: 'bo', gitappProjectId: 'p1', status: 'running' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-p2', name: 'shop-p2', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', gitappProjectId: 'p2', status: 'running' });
    const steps = createProjectRemovalActivities(deps());

    const planned = await steps.RemoveProjectAppsActivity({ projectId: 'p1' });
    expect(planned).toEqual([{
      deploymentId: 'odoo-p1',
      workflowId: expect.stringMatching(/^app-destroy-shop-p1-/),
      taskQueue: 'cluster-ops-queue',
      args: { name: 'shop-p1', clusterId: 'system', clusterName: 'provisioning-lunorica', provider: 'k3d', strategy: 'helm', logFile: '/logs/destroy.log', deploymentId: 'default', appType: 'odoo-project', namespace: 'shop-p1-1a2b3c' },
    }]);
    expect((await db.infrastructure.getDeployments()).find((deployment) => deployment.id === 'odoo-p1')?.status).toBe('destroying');

    expect(await steps.RemoveProjectRecordsActivity({ projectId: 'p1' })).toMatchObject({ deployments: 1 });
    expect((await db.infrastructure.getDeployments()).map((deployment) => deployment.id)).toEqual(['odoo-p2']);
  });

  it('plans nothing for a project with no app', async () => {
    expect(await createProjectRemovalActivities(deps()).RemoveProjectAppsActivity({ projectId: 'p1' })).toEqual([]);
  });

  it('finds nothing to do for a project already gone', async () => {
    const steps = createProjectRemovalActivities(deps());
    await steps.RemoveProjectRecordsActivity({ projectId: 'p1' });
    expect(await steps.RemoveProjectRecordsActivity({ projectId: 'p1' })).toEqual({});
    expect(await steps.RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual([]);
  });
});
