import { describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import { seedWorkspaceImages } from '../../engine/lib/workspace-image-seeds.js';
import type { ClusterService, TemporalBridge } from '../../infrastructure/index.js';
import { allowed, clusterResource, type ClusterMetadata, type PipelineRunMetadata, type Principal, type ProjectMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { ProjectRemovalPreview } from '../lib/project-removal.js';
import type { GiteaService } from '../services/GiteaService.js';
import type { ProjectChannelService } from '../services/ProjectChannelService.js';
import type { ProjectRemovalService } from '../services/ProjectRemovalService.js';
import type { NewProject, ProjectRepoService } from '../services/ProjectRepoService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type RouteAnswer } from '../../platform/testing/routes.js';
import { projectsRouter } from './projects.js';

const project: ProjectMetadata = { id: 'proj-1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', ownerId: TEST_USER.id, appType: 'gitapp', createdAt: '2026-01-01T00:00:00Z' };
const device = { id: 'dev-1', ownerId: TEST_USER.id, name: 'My Laptop', rootDir: '/x', tokenHash: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' };
const koalasCluster: ClusterMetadata = { id: 'machine-koala', name: 'koala', provider: 'machine', machineId: 'koala', status: 'healthy', ownerId: TEST_USER.id };

const plain = ({ status, data }: RouteAnswer) => ({ status, body: data });

async function setUp(withRemoval = true) {
  const db = memoryDatabase();
  const repos = mock<Pick<ProjectRepoService, 'createProject'>>();
  const bridge = mock<Pick<TemporalBridge, 'promoteProjectBuild'>>();
  const gitea = mock<Pick<GiteaService, 'getCommit'>>();
  const clusters = mock<Pick<ClusterService, 'getById'>>();
  const channels = mock<Pick<ProjectChannelService, 'ensure'>>();
  const removal = mock<Pick<ProjectRemovalService, 'preview' | 'remove'>>();
  repos.createProject.mockImplementation(async (ownerId, input: NewProject) => db.projects.saveProjectInfo({
    id: 'made', name: input.name, ownerId, giteaOwner: 'koala-u', giteaRepo: input.repo, appType: 'gitapp', createdAt: 'now',
    ...(input.targetClusterId ? { targetClusterId: input.targetClusterId } : {}),
    ...(input.extra ?? {}),
  }));
  clusters.getById.mockImplementation(async (id, principal: Principal) => {
    const found = id === koalasCluster.id ? koalasCluster : (await db.infrastructure.getClusters()).find((entry) => entry.id === id);
    return found && allowed(principal, 'deploy-to', clusterResource(found)) ? found : undefined;
  });
  const router = projectsRouter({
    db,
    getOwnedProject: async (id, principal) => {
      const found = (await db.projects.getProjects()).find((entry) => entry.id === id);
      return found && allowed(principal, 'see', { kind: 'project', ownerId: found.ownerId }) ? found : undefined;
    },
    projectRepoService: repos,
    temporalBridge: bridge,
    giteaService: gitea,
    clusterService: clusters,
    channels,
    ...(withRemoval ? { removal } : {}),
  });
  const routes = await routesInProcess({ prefix: '/', router: () => router, db });
  return { db, repos, bridge, gitea, clusters, channels, removal, routes };
}

const run = (over: Partial<PipelineRunMetadata> = {}): PipelineRunMetadata => ({ id: 'run-1', projectId: project.id, commitSha: 'abc123', ref: 'main', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', ...over });

describe('listing projects', () => {
  it('shows the caller\'s projects, each with where its builds stand', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'theirs', giteaRepo: 'theirs', ownerId: 'someone-else' });
    await db.releases.savePipelineRunInfo(run());
    const listed = (await routes.get('/')).data as (ProjectMetadata & { lastRun?: unknown })[];
    expect(listed.map((entry) => entry.id)).toEqual(['proj-1']);
  });
});

describe('a project\'s runs', () => {
  it('fetches the commit message from Gitea and keeps it for next time', async () => {
    const { db, gitea, routes } = await setUp();
    gitea.getCommit.calledWith('acme', 'demo', 'abc123').mockResolvedValue({ message: 'Fix the thing\n\nlonger body' });
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    const answer = (await routes.get('/proj-1/runs')).data as PipelineRunMetadata[];
    expect(answer.map((entry) => entry.commitMessage)).toEqual(['Fix the thing\n\nlonger body']);
    expect((await db.releases.getPipelineRuns())[0]?.commitMessage).toBe('Fix the thing\n\nlonger body');
  });

  it('does not ask again for a message the run already has', async () => {
    const { db, gitea, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run({ commitMessage: 'Already known' }));
    expect(((await routes.get('/proj-1/runs')).data as PipelineRunMetadata[])[0]?.commitMessage).toBe('Already known');
    expect(gitea.getCommit).not.toHaveBeenCalled();
  });

  it('keeps the run in the list, newest first, when Gitea does not answer or has no such commit', async () => {
    const { db, gitea, routes } = await setUp();
    gitea.getCommit.mockRejectedValueOnce(new Error('gitea unreachable'));
    gitea.getCommit.mockResolvedValueOnce(null);
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run({ id: 'older', startedAt: '2026-01-01T00:00:00Z' }));
    await db.releases.savePipelineRunInfo(run({ id: 'newer', startedAt: '2026-02-01T00:00:00Z' }));
    const answer = (await routes.get('/proj-1/runs')).data as PipelineRunMetadata[];
    expect(answer.map((entry) => [entry.id, entry.commitMessage])).toEqual([['newer', undefined], ['older', undefined]]);
  });

  it('leaves a run alone that has no commit to look up, and 404s a project that is not the caller\'s', async () => {
    const { db, gitea, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'theirs', giteaRepo: 'theirs', ownerId: 'someone-else' });
    await db.releases.savePipelineRunInfo(run({ commitSha: '' }));
    expect((await routes.get('/proj-1/runs')).data).toHaveLength(1);
    expect(gitea.getCommit).not.toHaveBeenCalled();
    expect(plain(await routes.get('/theirs/runs'))).toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});

describe('making a project', () => {
  it('asks for a name, and for a repository unless it runs on a machine of the person\'s', async () => {
    const { routes } = await setUp();
    expect(plain(await routes.post('/', { giteaRepo: 'demo' }))).toEqual({ status: 400, body: { error: 'name is required' } });
    expect(plain(await routes.post('/', { name: 'nothing' }))).toEqual({ status: 400, body: { error: 'giteaRepo is required unless the project runs on a registered local machine' } });
  });

  it('makes a project from a repository, opening its channel, and 201s it', async () => {
    const { repos, channels, routes } = await setUp();
    const answer = await routes.post('/', { name: 'demo', giteaRepo: 'demo', createRepo: true, autoDeployOnBuild: true });
    expect(answer).toMatchObject({ status: 201, data: { id: 'made', name: 'demo', giteaRepo: 'demo' } });
    expect(repos.createProject).toHaveBeenCalledWith(TEST_USER.id, matches<NewProject>((input) => input.name === 'demo' && input.repo === 'demo' && input.autoDeployOnBuild && input.existing === undefined && input.description === 'Provisioning project: demo'));
    expect(channels.ensure).toHaveBeenCalledWith(matches<ProjectMetadata>((made) => made.id === 'made'));
  });

  it('uses an existing repository unless told to create one', async () => {
    const { repos, routes } = await setUp();
    await routes.post('/', { name: 'demo', giteaRepo: 'demo' });
    expect(repos.createProject).toHaveBeenCalledWith(TEST_USER.id, matches<NewProject>((input) => input.existing === true && input.autoDeployOnBuild === false));
  });

  it('answers 500 with the reason when the project cannot be made', async () => {
    const { repos, routes } = await setUp();
    repos.createProject.mockRejectedValue(new Error('You already have 50 projects'));
    expect(plain(await routes.post('/', { name: 'demo', giteaRepo: 'demo' }))).toEqual({ status: 500, body: { error: 'You already have 50 projects' } });
  });

  it('keeps a language only when it is one of the workspace images', async () => {
    const { db, repos, routes } = await setUp();
    await seedWorkspaceImages(db.engine);
    await routes.post('/', { name: 'one', giteaRepo: 'one', language: 'python' });
    expect(repos.createProject).toHaveBeenLastCalledWith(TEST_USER.id, matches<NewProject>((input) => input.language === 'python'));
    await routes.post('/', { name: 'two', giteaRepo: 'two', language: 'nonsense' });
    expect(repos.createProject).toHaveBeenLastCalledWith(TEST_USER.id, matches<NewProject>((input) => input.language === undefined));
  });

  it('keeps a cluster that is the person\'s, and refuses one that is not', async () => {
    const { db, repos, routes } = await setUp();
    await db.infrastructure.saveCluster({ id: 'my-machine', name: 'my-machine', provider: 'machine', machineId: 'my-machine', status: 'healthy', ownerId: TEST_USER.id });
    await db.infrastructure.saveCluster({ id: 'their-machine', name: 'their-machine', provider: 'machine', machineId: 'their-machine', status: 'healthy', ownerId: 'someone-else' });
    expect((await routes.post('/', { name: 'demo', giteaRepo: 'demo', targetClusterId: 'my-machine' })).data).toMatchObject({ targetClusterId: 'my-machine' });
    expect(plain(await routes.post('/', { name: 'other', giteaRepo: 'other', targetClusterId: 'their-machine' }))).toEqual({ status: 400, body: { error: 'Deploy to one of your own clusters.' } });
    expect(repos.createProject).toHaveBeenCalledTimes(1);
  });

  it('accepts the cluster Koala runs in from its owner, and from nobody else', async () => {
    const { routes } = await setUp();
    expect((await routes.post('/', { name: 'demo', giteaRepo: 'demo', targetClusterId: koalasCluster.id })).data).toMatchObject({ targetClusterId: koalasCluster.id });
    expect(plain(await routes.post('/', { name: 'other', giteaRepo: 'other', targetClusterId: koalasCluster.id }, { user: { id: 'someone-else', email: 'else@example.com' } }))).toEqual({ status: 400, body: { error: 'Deploy to one of your own clusters.' } });
  });
});

describe('making a project that runs on one of the person\'s machines', () => {
  it('makes one with no repository, a local project with the device as its target', async () => {
    const { db, repos, channels, routes } = await setUp();
    await db.machines.saveLocalAgentDevice(device);
    const answer = await routes.post('/', { name: 'local-only', executionTargetDeviceId: 'dev-1', executionApproval: 'auto' });
    expect(answer.status).toBe(201);
    expect(answer.data).toMatchObject({ giteaRepo: '', appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'auto' });
    expect(repos.createProject).not.toHaveBeenCalled();
    expect(channels.ensure).toHaveBeenCalledTimes(1);
  });

  it('keeps the folder and the egress rules it was given, and drops an approval that is not auto or plan', async () => {
    const { db, routes } = await setUp();
    await db.machines.saveLocalAgentDevice(device);
    const answer = await routes.post('/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1', executionTargetPath: ' apps/two ', executionTargetEgress: [{ host: 'registry.npmjs.org', ports: [443] }], executionApproval: 'whenever' });
    expect(answer.data).toMatchObject({ executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/two', egress: [{ host: 'registry.npmjs.org', ports: [443] }] } });
    expect((answer.data as ProjectMetadata).executionApproval).toBeUndefined();
  });

  it('refuses a device that is not the caller\'s, an egress rule that is not a host, and a device and folder another project holds', async () => {
    const { db, repos, routes } = await setUp();
    await db.machines.saveLocalAgentDevice({ ...device, id: 'not-mine', ownerId: 'someone-else' });
    await db.machines.saveLocalAgentDevice(device);
    expect(plain(await routes.post('/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'not-mine' }))).toEqual({ status: 400, body: { error: 'Unknown local execution device' } });
    expect((await routes.post('/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1', executionTargetEgress: [{ host: 'not a host' }] })).status).toBe(400);
    await db.projects.saveProjectInfo({ ...project, id: 'holder', giteaRepo: 'holder', executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/one' } });
    expect((await routes.post('/', { name: 'demo2', giteaRepo: 'demo2', executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/one' })).status).toBe(409);
    expect((await routes.post('/', { name: 'demo3', giteaRepo: 'demo3', executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/two' })).status).toBe(201);
    expect(repos.createProject).toHaveBeenCalledTimes(1);
  });

  it('ignores egress rules when no device is chosen', async () => {
    const { routes } = await setUp();
    const answer = await routes.post('/', { name: 'demo', giteaRepo: 'demo', executionTargetEgress: [{ host: 'registry.npmjs.org' }] });
    expect((answer.data as ProjectMetadata).executionTarget).toBeUndefined();
  });
});

describe('changing a project', () => {
  it('lets a project pick up a device of the caller\'s, with its folder', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.machines.saveLocalAgentDevice(device);
    const answer = await routes.patch('/proj-1', { executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/one' });
    expect(answer).toMatchObject({ status: 200, data: { executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/one' } } });
  });

  it('goes back to the cluster when the device is cleared', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveProjectInfo({ ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect((await routes.patch('/proj-1', { executionTargetDeviceId: '' })).data).toMatchObject({ executionTarget: { kind: 'k8s' } });
  });

  it('lets a project keep its own device while changing its approval, and refuses one another project holds', async () => {
    const { db, routes } = await setUp();
    await db.machines.saveLocalAgentDevice(device);
    await db.projects.saveProjectInfo({ ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect((await routes.patch('/proj-1', { executionTargetDeviceId: 'dev-1', executionApproval: 'plan' })).data).toMatchObject({ executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'plan' });
    await db.projects.saveProjectInfo({ ...project, id: 'proj-2', giteaRepo: 'other' });
    expect((await routes.patch('/proj-2', { executionTargetDeviceId: 'dev-1' })).status).toBe(409);
  });

  it('refuses a device that is not the caller\'s and an egress rule that is not a host', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.machines.saveLocalAgentDevice({ ...device, id: 'not-mine', ownerId: 'someone-else' });
    await db.machines.saveLocalAgentDevice(device);
    expect((await routes.patch('/proj-1', { executionTargetDeviceId: 'not-mine' })).status).toBe(400);
    expect((await routes.patch('/proj-1', { executionTargetDeviceId: 'dev-1', executionTargetEgress: [{ host: 'not a host' }] })).status).toBe(400);
  });

  it('404s a project that is not the caller\'s', async () => {
    const { db, routes } = await setUp();
    await db.projects.saveProjectInfo({ ...project, giteaRepo: 'theirs', ownerId: 'someone-else' });
    expect(plain(await routes.patch('/proj-1', { executionTargetDeviceId: 'dev-1' }))).toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});

describe('promoting a build', () => {
  it('starts the deployment of the project\'s run and answers 202 with the workflow', async () => {
    const { db, bridge, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    bridge.promoteProjectBuild.mockResolvedValue({ id: 'wf-1', resourceId: 'dep-1' } as Awaited<ReturnType<TemporalBridge['promoteProjectBuild']>>);
    expect(plain(await routes.post('/proj-1/runs/run-1/promote'))).toEqual({ status: 202, body: { message: 'Promoting build to deployment', workflowId: 'wf-1', deploymentId: 'dep-1' } });
    expect(bridge.promoteProjectBuild).toHaveBeenCalledWith(matches<ProjectMetadata>((made) => made.id === 'proj-1'), matches<PipelineRunMetadata>((given) => given.id === 'run-1'), TEST_USER.id);
  });

  it('refuses a project or run that is not there, and a project being deleted', async () => {
    const { db, bridge, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'going', giteaRepo: 'going', removal: { startedAt: 't', requestedBy: TEST_USER.id } });
    await db.releases.savePipelineRunInfo(run());
    await db.releases.savePipelineRunInfo(run({ id: 'run-2', projectId: 'going' }));
    await db.releases.savePipelineRunInfo(run({ id: 'run-3', projectId: 'other' }));
    expect(plain(await routes.post('/nope/runs/run-1/promote'))).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(plain(await routes.post('/proj-1/runs/run-3/promote'))).toEqual({ status: 404, body: { error: 'Run not found' } });
    expect(plain(await routes.post('/going/runs/run-2/promote'))).toEqual({ status: 409, body: { error: 'This project is being deleted' } });
    expect(bridge.promoteProjectBuild).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason when the promotion cannot start', async () => {
    const { db, bridge, routes } = await setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    bridge.promoteProjectBuild.mockRejectedValue(new Error('waiting for the person to enter API_KEY'));
    expect(plain(await routes.post('/proj-1/runs/run-1/promote'))).toEqual({ status: 400, body: { error: 'waiting for the person to enter API_KEY' } });
  });
});

describe('deleting a project', () => {
  const preview: ProjectRemovalPreview & { state: { state: 'none' } } = { name: 'demo', trees: [], keptConversations: 0, builds: 0, apps: [], state: { state: 'none' } };

  it('shows what would go, or 404s a project that is not the caller\'s', async () => {
    const { removal, routes } = await setUp();
    removal.preview.calledWith(TEST_USER.id, 'proj-1').mockResolvedValue(preview);
    expect(plain(await routes.get('/proj-1/removal'))).toEqual({ status: 200, body: preview });
    expect(plain(await routes.get('/nope/removal'))).toEqual({ status: 404, body: { error: 'Project not found' } });
  });

  it('passes the typed name on and answers 202 with the state once it has started', async () => {
    const { removal, routes } = await setUp();
    removal.remove.mockResolvedValue({ ok: true, state: { state: 'running' } as never });
    expect(plain(await routes.delete('/proj-1', { body: { confirm: 'demo' } }))).toEqual({ status: 202, body: { state: { state: 'running' } } });
    expect(removal.remove).toHaveBeenCalledWith(TEST_USER.id, 'proj-1', 'demo');
    await routes.delete('/proj-1');
    expect(removal.remove).toHaveBeenLastCalledWith(TEST_USER.id, 'proj-1', '');
  });

  it('answers a refusal with its status and the refusal itself', async () => {
    const { removal, routes } = await setUp();
    removal.remove.mockResolvedValue({ ok: false, refusal: { status: 400, error: 'Type the project\'s name, demo, to confirm' } });
    expect(plain(await routes.delete('/proj-1', { body: { confirm: 'x' } }))).toEqual({ status: 400, body: { status: 400, error: 'Type the project\'s name, demo, to confirm' } });
  });

  it('says projects cannot be deleted here when the server has no removal service', async () => {
    const { routes } = await setUp(false);
    expect(plain(await routes.get('/proj-1/removal'))).toEqual({ status: 404, body: { error: 'Projects cannot be deleted here' } });
    expect(plain(await routes.delete('/proj-1', { body: { confirm: 'demo' } }))).toEqual({ status: 404, body: { error: 'Projects cannot be deleted here' } });
  });
});
