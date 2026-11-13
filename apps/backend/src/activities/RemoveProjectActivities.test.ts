import { MockActivityEnvironment } from '@temporalio/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import type { Database } from '../platform/lib/db-interface.js';
import { memoryDatabase } from '../platform/testing/memory-database.js';
import { planAppDestroys, createProjectRemovalActivities, type ProjectRemovalActivities, type ProjectRemovalDeps } from './RemoveProjectActivities.js';

type Files = ProjectRemovalDeps['files'];
type Artifacts = NonNullable<ProjectRemovalDeps['artifacts']>;

let db: Database;
let workflows: ReturnType<typeof mock<ProjectRemovalDeps['workflows']>>;
let kube: ReturnType<typeof mockFn<KubeRunner>>;
let repositories: ReturnType<typeof mock<ProjectRemovalDeps['repositories']>>;
let secrets: ReturnType<typeof mock<ProjectRemovalDeps['secrets']>>;
let files: ReturnType<typeof mock<Files>>;
let artifacts: ReturnType<typeof mock<Artifacts>>;

const at = 'then';

const steps = (over: Partial<ProjectRemovalDeps> = {}): ProjectRemovalActivities => createProjectRemovalActivities({
  store: db,
  workflows,
  kube,
  repositories,
  secrets,
  files,
  apps: {
    clusterById: async (id) => (id === 'system' ? { id: 'system', name: 'koala', provider: 'machine', machineId: 'koala', status: 'running' } as never : undefined),
    handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), 
    logFile: () => '/logs/destroy.log',
    taskQueue: 'cluster-ops-queue',
  },
  now: () => Date.parse('2026-11-13T10:00:00.000Z'),
  ...over,
});

beforeEach(async () => {
  db = memoryDatabase();
  workflows = mock<ProjectRemovalDeps['workflows']>();
  workflows.stopIfRunning.mockResolvedValue(true);
  kube = mockFn<KubeRunner>();
  kube.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  repositories = mock<ProjectRemovalDeps['repositories']>();
  secrets = mock<ProjectRemovalDeps['secrets']>();
  secrets.removeProject.mockResolvedValue({ workspace: true, readers: 1 });
  files = mock<Files>();
  files.removeProjectFiles.mockResolvedValue(3);
  artifacts = mock<Artifacts>();
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
  it('ends the project\'s fence with the processes live as it ends, and drops it at once when none is left from before', async () => {
    await db.platform.raiseFence({ kind: 'project', id: 'p1' }, '2026-11-13T09:00:00.000Z');
    expect(await new MockActivityEnvironment().run(steps().RemoveProjectFenceEndActivity, { projectId: 'p1' })).toEqual([{ kind: 'project', id: 'p1' }]);
    expect(await db.platform.fencesRaised()).toEqual([]);
  });

  it('marks the project as being deleted, raises its fence, and goes on only once every live process holds it', async () => {
    await db.platform.beatProcess({ id: 'engine-1', name: 'worker-engine' }, '2026-11-13T09:59:55.000Z');
    let finished = false;
    const fenced = new MockActivityEnvironment().run(steps().RemoveProjectFenceActivity, { projectId: 'p1' }).then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect((await db.projects.getProjects()).find((project) => project.id === 'p1')?.removal).toEqual({ startedAt: '2026-11-13T10:00:00.000Z', requestedBy: 'bo' });
    expect(finished).toBe(false);
    await db.platform.ackFence({ kind: 'project', id: 'p1' }, 'engine-1', '2026-11-13T10:00:01.000Z');
    await fenced;
    expect(await db.platform.fencesRaised()).toEqual([{ closing: { kind: 'project', id: 'p1' }, at: '2026-11-13T10:00:00.000Z', confirmed: true }]);
  });

  it('stops its running builds and its trees\' runs, and no other project\'s, heartbeating as it goes', async () => {
    const env = new MockActivityEnvironment();
    let beats = 0;
    env.on('heartbeat', () => { beats += 1; });
    const stopped = await env.run(() => steps().RemoveProjectWorkflowsActivity({ projectId: 'p1' }));
    expect(workflows.stopIfRunning.mock.calls.map(([id]) => id)).toEqual(['release-p1', 'pipeline-r1', 'grove-run-t1', 'conclude-workspace-tree-t1']);
    expect(workflows.stopIfRunning).toHaveBeenCalledWith('release-p1', 'the project was deleted');
    expect(stopped).toBe(4);
    expect(beats).toBe(4);
  });

  it('counts only the workflows that were running, and does nothing for a project that is gone', async () => {
    workflows.stopIfRunning.mockImplementation(async (id) => id === 'pipeline-r1');
    expect(await steps().RemoveProjectWorkflowsActivity({ projectId: 'p1' })).toBe(1);
    workflows.stopIfRunning.mockClear();
    expect(await steps().RemoveProjectWorkflowsActivity({ projectId: 'nope' })).toBe(0);
    expect(workflows.stopIfRunning).not.toHaveBeenCalled();
  });

  it('deletes its trees\' workspaces and those of their conversations in one call, its secrets, and its repositories', async () => {
    expect(await steps().RemoveProjectWorkspacesActivity({ projectId: 'p1' })).toBe(2);
    expect(kube).toHaveBeenCalledWith(['delete', 'namespace', 'koala-run-tree-t1', 'koala-run-conversation-c1', '--ignore-not-found', '--wait=true', '--timeout=720h']);
    await steps().RemoveProjectSecretsActivity({ projectId: 'p1' });
    expect(secrets.removeProject).toHaveBeenCalledWith('p1');
    expect(await steps().RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual(['koala-bo/shop-p1', 'koala-bo/tree-t1', 'koala-bo/research-c1']);
    expect(repositories.deleteRepo.mock.calls).toEqual([['koala-bo', 'shop-p1'], ['koala-bo', 'tree-t1'], ['koala-bo', 'research-c1']]);
  });

  it('refuses to go on when the cluster would not delete the workspaces, and has none to delete for a project without trees', async () => {
    kube.mockResolvedValue({ stdout: '', stderr: 'forbidden', exitCode: 1 });
    await expect(steps().RemoveProjectWorkspacesActivity({ projectId: 'p1' })).rejects.toThrow('the project\'s workspaces could not be deleted: forbidden');
    kube.mockClear();
    await db.projects.saveProject({ id: 'p3', name: 'bare', ownerId: 'bo', appType: 'gitapp', createdAt: at });
    expect(await steps().RemoveProjectWorkspacesActivity({ projectId: 'p3' })).toBe(0);
    expect(await steps().RemoveProjectWorkspacesActivity({ projectId: 'nope' })).toBe(0);
    expect(kube).not.toHaveBeenCalled();
  });

  it('deletes only the project\'s own repository when the person has no Gitea account', async () => {
    await db.projects.saveGiteaAccount({ ownerId: 'bo', username: 'koala-bo', passwordEnc: 'x', createdAt: at });
    await db.projects.saveProject({ id: 'p4', name: 'solo', ownerId: 'cy', giteaOwner: 'koala-cy', giteaRepo: 'solo', appType: 'gitapp', createdAt: at });
    expect(await steps().RemoveProjectRepositoriesActivity({ projectId: 'p4' })).toEqual(['koala-cy/solo']);
  });

  it('removes the project\'s secrets through the secrets service', async () => {
    expect(await steps().RemoveProjectSecretsActivity({ projectId: 'p2' })).toEqual({ workspace: true, readers: 1 });
  });

  it('removes everything the project keeps as its owner, and nothing for a project that is not there', async () => {
    expect(await steps().RemoveProjectFilesActivity({ projectId: 'p1' })).toBe(3);
    expect(files.removeProjectFiles).toHaveBeenCalledExactlyOnceWith('bo', 'p1');
    expect(await steps().RemoveProjectFilesActivity({ projectId: 'nope' })).toBe(0);
    expect(files.removeProjectFiles).toHaveBeenCalledOnce();
  });

  it('deletes its records, unlinks what only mentions it, and leaves the other project whole', async () => {
    const removed = await steps().RemoveProjectRecordsActivity({ projectId: 'p1' });

    expect(removed).toMatchObject({ trees: 1, branches: 1, leaves: 1, conversations: 1, 'trees unlinked': 1, pipelineRuns: 1, 'conversations unlinked': 1, projects: 1 });
    expect((await db.projects.getProjects()).map((project) => project.id)).toEqual(['p2']);
    expect((await db.projects.getTrees()).map((tree) => [tree.id, tree.projectIds])).toEqual([['t2', ['p2']]]);
    expect((await db.projects.getTasks('bo')).map((task) => task.id)).toEqual([]);
    expect(await db.engine.getConversation('bo', 'c1')).toBeUndefined();
    expect((await db.engine.getConversation('bo', 'c2'))?.projectId).toBeUndefined();
    expect((await db.projects.getLeaves())).toEqual([]);
    expect((await db.releases.getPipelineRuns()).map((run) => run.id)).toEqual(['r2']);
  });

  it('removes what its releases\' browser tests kept, and nothing of another project\'s', async () => {
    for (const [id, projectId] of [['rel1', 'p1'], ['rel2', 'p2']] as const) {
      await db.releases.saveOdooRelease({ id, ownerId: 'bo', projectId, pipelineRunId: 'x', commit: 'c', image: 'i:t', state: 'preview', host: 'h', startedAt: at, updatedAt: at });
    }
    artifacts.removeRun.mockResolvedValue(3);
    const removed = await steps({ artifacts }).RemoveProjectRecordsActivity({ projectId: 'p1' });
    expect(removed).toMatchObject({ artifacts: 3 });
    expect(artifacts.removeRun.mock.calls).toEqual([['bo', 'rel1']]);
  });

  it('plans the destroy of each app built from it, on the app\'s own cluster and namespace, and deletes the app\'s record with the rest', async () => {
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-p1', name: 'shop-p1', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', namespace: 'shop-p1-1a2b3c', ownerId: 'bo', gitappProjectId: 'p1', status: 'running' });
    await db.infrastructure.saveDeploymentInfo({ id: 'odoo-p2', name: 'shop-p2', clusterId: 'system', strategy: 'helm', appType: 'odoo-project', ownerId: 'bo', gitappProjectId: 'p2', status: 'running' });

    const planned = await steps().RemoveProjectAppsActivity({ projectId: 'p1' });
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      deploymentId: 'odoo-p1',
      taskQueue: 'cluster-ops-queue',
      args: { name: 'shop-p1', clusterId: 'system', clusterName: 'koala', strategy: 'helm', logFile: '/logs/destroy.log', appType: 'odoo-project', namespace: 'shop-p1-1a2b3c', reach: { clusterId: 'system', kind: 'koala' } },
    });
    expect(planned[0]!.workflowId).toMatch(/^app-destroy-shop-p1-/);
    const marked = (await db.infrastructure.getDeployments()).find((deployment) => deployment.id === 'odoo-p1');
    expect(marked, 'nothing names a destroy before it has started, or a follower would find no such workflow').toMatchObject({ status: 'destroying', temporalWorkflowId: '', lastLogPath: '/logs/destroy.log' });
    await steps().RemoveProjectAppStartedActivity({ deploymentId: 'odoo-p1', workflowId: planned[0]!.workflowId });
    expect((await db.infrastructure.getDeployments()).find((deployment) => deployment.id === 'odoo-p1')).toMatchObject({ status: 'destroying', temporalWorkflowId: planned[0]!.workflowId });

    expect(await steps().RemoveProjectRecordsActivity({ projectId: 'p1' })).toMatchObject({ deployments: 1 });
    expect((await db.infrastructure.getDeployments()).map((deployment) => deployment.id)).toEqual(['odoo-p2']);
  });

  it('plans nothing for a project with no app, or one that is gone', async () => {
    expect(await steps().RemoveProjectAppsActivity({ projectId: 'p1' })).toEqual([]);
    expect(await steps().RemoveProjectAppsActivity({ projectId: 'nope' })).toEqual([]);
  });

  it('finds nothing to do for a project already gone', async () => {
    await db.projects.saveProject({ id: 'p9', name: 'x', ownerId: 'bo', appType: 'gitapp', createdAt: at });
    expect(await steps().RemoveProjectRecordsActivity({ projectId: 'nope' })).toEqual({});
    expect(await steps().RemoveProjectRepositoriesActivity({ projectId: 'nope' })).toEqual([]);
    expect(await steps().RemoveProjectFilesActivity({ projectId: 'nope' })).toBe(0);
  });
});

describe('planning the destroy of apps', () => {
  it('names a workflow for each app asked about, with its cluster found by id, and skips the rest', async () => {
    const deployments = [
      { id: 'a', name: 'one', clusterId: 'system', strategy: 'helm', appType: 'wordpress', status: 'running' },
      { id: 'b', name: 'two', clusterId: 'gone', strategy: 'helm', appType: 'wordpress', status: 'running' },
    ] as never[];
    const planned = await planAppDestroys(deployments, ['b'], { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/l', taskQueue: 'q' }, () => 'abc123');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ deploymentId: 'b', taskQueue: 'q', args: { reach: { clusterId: 'gone', kind: 'koala' } } });
    expect(planned[0]!.workflowId).toMatch(/abc123$/);
  });

  it('hands a machine\'s app over as the machine to start, naming the app that leaves it, and no reach', async () => {
    const deployments = [{ id: 'books', name: 'books', clusterId: 'machine-desk', strategy: 'native', appType: 'nginx', status: 'running' }] as never[];
    const planned = await planAppDestroys(deployments, ['books'], {
      clusterById: async () => ({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'stopped' }) as never,
      handOver: async (clusterId) => ({ clusterId, machine: { deviceId: 'desk' } }),
      logFile: () => '/l',
      taskQueue: 'q',
    }, () => 'abc123');
    expect(planned[0]!.args).toMatchObject({ clusterId: 'machine-desk', clusterName: 'desk', machine: { deviceId: 'desk', leaving: 'books' } });
    expect(planned[0]!.args).not.toHaveProperty('reach');
    expect(planned[0]!.args).not.toHaveProperty('provider');
  });

  it('plans nothing, and says why, for an app whose cluster cannot be reached', async () => {
    const deployments = [{ id: 'b', name: 'two', clusterId: 'old', strategy: 'helm', status: 'running' }] as never[];
    const unreachable = Object.assign(new Error('old is a k3d cluster, and every cluster Koala reaches is a machine\'s'), { name: 'ClusterUnreachable' });
    await expect(planAppDestroys(deployments, ['b'], { clusterById: async () => undefined, handOver: async () => { throw unreachable; }, logFile: () => '/l', taskQueue: 'q' }, () => 'abc123'))
      .rejects.toThrow('every cluster Koala reaches is a machine\'s');
  });
});
