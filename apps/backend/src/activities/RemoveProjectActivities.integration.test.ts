import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { emptiedEachTime } from '../platform/lib/test-database.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from './RemoveProjectActivities.js';
import { Readable } from 'node:stream';
import { ArtifactService } from '../files/services/ArtifactService.js';
import { FileService } from '../files/services/FileService.js';
import { storedFilesOn } from '../files/testing/stored-files-twin.js';
import { seedTwoProjects } from '../projects/testing/project-world.js';
import { indexingFrom, indexMemories } from '../memory/lib/memory-index.js';
import { MEMORY_COLLECTION, MEMORY_INDEX } from '../memory/lib/memory-rank.js';
import { startCorpusStandIn } from '../engine/testing/corpus-stand-in.js';

const fresh = await emptiedEachTime();
const standIn = await startCorpusStandIn();
afterAll(async () => { await standIn.stop(); });

let db: MongoDB;
let kubectl: string[][];
let repos: string[];
let secrets: string[];
let storedFiles: ReturnType<typeof storedFilesOn> | undefined;
const stored = (): ReturnType<typeof storedFilesOn> => (storedFiles ??= storedFilesOn(db.files));

const deps = (): ProjectRemovalDeps => ({
  store: db,
  kube: async (args) => { kubectl.push(args); return { stdout: '', stderr: '', exitCode: 0 }; },
  repositories: { deleteRepo: async (owner, name) => { repos.push(`${owner}/${name}`); } },
  secrets: { removeProject: async (projectId) => { secrets.push(projectId); return { workspace: true, readers: 1 }; } },
  webhooks: { unhook: async () => 0 },
  files: new FileService({ files: stored().files, shares: db.files }),
  memoryIndex: indexingFrom(standIn.reach),
  apps: {
    clusterById: async (id) => (id === 'system' ? { id: 'system', name: 'koala', provider: 'machine', machineId: 'koala', status: 'running' } as never : undefined),
    handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }),
    logFile: () => '/logs/destroy.log',
    taskQueue: 'cluster-ops-queue',
  },
});

const at = 'then';

beforeEach(async () => {
  db = await fresh();
  kubectl = [];
  repos = [];
  secrets = [];
  storedFiles = undefined;
  await seedTwoProjects(db, at);
});

describe('the steps that delete a project', () => {
  it('deletes its trees\' workspaces and those of their conversations, its secrets, and its repositories', async () => {
    const steps = createProjectRemovalActivities(deps());
    expect(await steps.RemoveProjectWorkspacesActivity({ projectId: 'p1' })).toBe(2);
    expect(kubectl[0]).toEqual(['delete', 'namespace', 'koala-run-tree-t1', 'koala-run-conversation-c1', '--ignore-not-found', '--wait=true', '--timeout=720h']);
    await steps.RemoveProjectSecretsActivity({ projectId: 'p1' });
    expect(secrets).toEqual(['p1']);
    expect(await steps.RemoveProjectRepositoriesActivity({ projectId: 'p1' })).toEqual(['koala-bo/shop-p1', 'koala-bo/tree-t1', 'koala-bo/research-c1']);
  });

  it('removes every file the project keeps, its chats\' included, and nothing of another project or the person\'s own', async () => {
    const files = stored().files;
    for (const [scope, path] of [[{ kind: 'project', id: 'p1' }, 'brief.pdf'], [{ kind: 'project', id: 'p1' }, 'chats/c2/shot.png'], [{ kind: 'project', id: 'p2' }, 'other.pdf'], [{ kind: 'person', id: 'bo' }, 'mine.txt']] as const) {
      const kept = await files.at('bo', scope).upload(path, Readable.from([Buffer.from('x')]), 1, 'text/plain', { replace: true });
      if (!kept.ok) throw new Error(kept.why);
    }
    const steps = createProjectRemovalActivities(deps());
    expect(await steps.RemoveProjectFilesActivity({ projectId: 'p1' })).toBe(2);
    expect(await db.files.storedFilesIn('bo', { kind: 'project', id: 'p1' })).toEqual([]);
    expect((await db.files.storedFilesIn('bo', { kind: 'project', id: 'p2' })).map((record) => record.path)).toEqual(['other.pdf']);
    expect((await db.files.storedFilesIn('bo', { kind: 'person', id: 'bo' })).map((record) => record.path)).toEqual(['mine.txt']);
    expect(await steps.RemoveProjectFilesActivity({ projectId: 'nope' })).toBe(0);
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

  it('deletes the project\'s own memories for good, their index entries with them, and keeps what the person learned in it for everywhere', async () => {
    const memory = (id: string, projectId: string, scope: 'project' | 'global') => ({ id, ownerId: 'bo', projectId, scope, category: 'environment_facts' as const, status: 'active' as const, title: id, text: `about ${id}`, createdAt: at, updatedAt: at });
    for (const item of [memory('its-own', 'p1', 'project'), memory('learned-there', 'p1', 'global'), memory('the-other', 'p2', 'project')]) await db.memory.saveMemory(item);
    await indexMemories(standIn.reach, (await db.memory.getMemories('bo')).filter((item) => ['its-own', 'learned-there', 'the-other'].includes(item.id)));

    const removed = await createProjectRemovalActivities(deps()).RemoveProjectRecordsActivity({ projectId: 'p1' });

    expect(removed).toMatchObject({ memories: 1 });
    const left = new Map((await db.memory.getMemories('bo')).map((item) => [item.id, item]));
    expect(left.has('its-own')).toBe(false);
    expect(left.get('learned-there')?.scope).toBe('global');
    expect(left.get('the-other')?.projectId).toBe('p2');
    expect(standIn.documents(MEMORY_INDEX).map((doc) => doc.memory_id).sort()).toEqual(['learned-there', 'the-other']);
    expect(standIn.points(MEMORY_COLLECTION).map((point) => point.memory_id).sort()).toEqual(['learned-there', 'the-other']);
  });

  it('removes what its releases\' browser tests kept, and nothing of another project\'s', async () => {
    const artifacts = new ArtifactService({ files: stored().files });
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
      workflowId: expect.stringMatching(/^app-destroy-shop-p1-/) as unknown,
      taskQueue: 'cluster-ops-queue',
      args: { name: 'shop-p1', clusterId: 'system', clusterName: 'koala', strategy: 'helm', logFile: '/logs/destroy.log', appType: 'odoo-project', namespace: 'shop-p1-1a2b3c', reach: { clusterId: 'system', kind: 'koala' } },
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
