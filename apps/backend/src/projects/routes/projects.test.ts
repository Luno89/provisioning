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
import { CALLER, callRouter, del, get, patch, post } from '../testing/route-call.js';
import { projectsRouter } from './projects.js';

const project: ProjectMetadata = { id: 'proj-1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', ownerId: CALLER.id, appType: 'gitapp', createdAt: '2026-01-01T00:00:00Z' };
const device = { id: 'dev-1', ownerId: CALLER.id, name: 'My Laptop', rootDir: '/x', tokenEnc: 'irrelevant', createdAt: '2026-01-01T00:00:00Z' };
const systemCluster: ClusterMetadata = { id: 'provisioning-lunorica', name: 'provisioning-lunorica', provider: 'k3d', status: 'healthy', isSystem: true };

function setUp(withRemoval = true) {
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
    const found = id === systemCluster.id ? systemCluster : (await db.infrastructure.getClusters()).find((entry) => entry.id === id);
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
  return { db, repos, bridge, gitea, clusters, channels, removal, router };
}

const run = (over: Partial<PipelineRunMetadata> = {}): PipelineRunMetadata => ({ id: 'run-1', projectId: project.id, commitSha: 'abc123', ref: 'main', status: 'succeeded', startedAt: '2026-01-01T00:00:00Z', ...over });

describe('listing projects', () => {
  it('shows the caller\'s projects, each with where its builds stand', async () => {
    const { db, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'theirs', giteaRepo: 'theirs', ownerId: 'someone-else' });
    await db.releases.savePipelineRunInfo(run());
    const listed = (await get(router, '/')).body as (ProjectMetadata & { lastRun?: unknown })[];
    expect(listed.map((entry) => entry.id)).toEqual(['proj-1']);
  });
});

describe('a project\'s runs', () => {
  it('fetches the commit message from Gitea and keeps it for next time', async () => {
    const { db, gitea, router } = setUp();
    gitea.getCommit.calledWith('acme', 'demo', 'abc123').mockResolvedValue({ message: 'Fix the thing\n\nlonger body' });
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    const answer = (await get(router, '/proj-1/runs')).body as PipelineRunMetadata[];
    expect(answer.map((entry) => entry.commitMessage)).toEqual(['Fix the thing\n\nlonger body']);
    expect((await db.releases.getPipelineRuns())[0]?.commitMessage).toBe('Fix the thing\n\nlonger body');
  });

  it('does not ask again for a message the run already has', async () => {
    const { db, gitea, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run({ commitMessage: 'Already known' }));
    expect(((await get(router, '/proj-1/runs')).body as PipelineRunMetadata[])[0]?.commitMessage).toBe('Already known');
    expect(gitea.getCommit).not.toHaveBeenCalled();
  });

  it('keeps the run in the list, newest first, when Gitea does not answer or has no such commit', async () => {
    const { db, gitea, router } = setUp();
    gitea.getCommit.mockRejectedValueOnce(new Error('gitea unreachable'));
    gitea.getCommit.mockResolvedValueOnce(null);
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run({ id: 'older', startedAt: '2026-01-01T00:00:00Z' }));
    await db.releases.savePipelineRunInfo(run({ id: 'newer', startedAt: '2026-02-01T00:00:00Z' }));
    const answer = (await get(router, '/proj-1/runs')).body as PipelineRunMetadata[];
    expect(answer.map((entry) => [entry.id, entry.commitMessage])).toEqual([['newer', undefined], ['older', undefined]]);
  });

  it('leaves a run alone that has no commit to look up, and 404s a project that is not the caller\'s', async () => {
    const { db, gitea, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'theirs', giteaRepo: 'theirs', ownerId: 'someone-else' });
    await db.releases.savePipelineRunInfo(run({ commitSha: '' }));
    expect((await get(router, '/proj-1/runs')).body).toHaveLength(1);
    expect(gitea.getCommit).not.toHaveBeenCalled();
    expect(await get(router, '/theirs/runs')).toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});

describe('making a project', () => {
  it('asks for a name, and for a repository unless it runs on a machine of the person\'s', async () => {
    const { router } = setUp();
    expect(await post(router, '/', { giteaRepo: 'demo' })).toEqual({ status: 400, body: { error: 'name is required' } });
    expect(await post(router, '/', { name: 'nothing' })).toEqual({ status: 400, body: { error: 'giteaRepo is required unless the project runs on a registered local machine' } });
  });

  it('makes a project from a repository, opening its channel, and 201s it', async () => {
    const { repos, channels, router } = setUp();
    const answer = await post(router, '/', { name: 'demo', giteaRepo: 'demo', createRepo: true, autoDeployOnBuild: true });
    expect(answer).toMatchObject({ status: 201, body: { id: 'made', name: 'demo', giteaRepo: 'demo' } });
    expect(repos.createProject).toHaveBeenCalledWith(CALLER.id, matches<NewProject>((input) => input.name === 'demo' && input.repo === 'demo' && input.autoDeployOnBuild && input.existing === undefined && input.description === 'Provisioning project: demo'));
    expect(channels.ensure).toHaveBeenCalledWith(matches<ProjectMetadata>((made) => made.id === 'made'));
  });

  it('uses an existing repository unless told to create one', async () => {
    const { repos, router } = setUp();
    await post(router, '/', { name: 'demo', giteaRepo: 'demo' });
    expect(repos.createProject).toHaveBeenCalledWith(CALLER.id, matches<NewProject>((input) => input.existing === true && input.autoDeployOnBuild === false));
  });

  it('answers 500 with the reason when the project cannot be made', async () => {
    const { repos, router } = setUp();
    repos.createProject.mockRejectedValue(new Error('You already have 50 projects'));
    expect(await post(router, '/', { name: 'demo', giteaRepo: 'demo' })).toEqual({ status: 500, body: { error: 'You already have 50 projects' } });
  });

  it('keeps a language only when it is one of the workspace images', async () => {
    const { db, repos, router } = setUp();
    await seedWorkspaceImages(db.engine);
    await post(router, '/', { name: 'one', giteaRepo: 'one', language: 'python' });
    expect(repos.createProject).toHaveBeenLastCalledWith(CALLER.id, matches<NewProject>((input) => input.language === 'python'));
    await post(router, '/', { name: 'two', giteaRepo: 'two', language: 'nonsense' });
    expect(repos.createProject).toHaveBeenLastCalledWith(CALLER.id, matches<NewProject>((input) => input.language === undefined));
  });

  it('keeps a cluster that is the person\'s, and refuses one that is not', async () => {
    const { db, repos, router } = setUp();
    await db.infrastructure.saveCluster({ id: 'my-k3d', name: 'my-k3d', provider: 'k3d', status: 'healthy', ownerId: CALLER.id });
    await db.infrastructure.saveCluster({ id: 'their-k3d', name: 'their-k3d', provider: 'k3d', status: 'healthy', ownerId: 'someone-else' });
    expect((await post(router, '/', { name: 'demo', giteaRepo: 'demo', targetClusterId: 'my-k3d' })).body).toMatchObject({ targetClusterId: 'my-k3d' });
    expect(await post(router, '/', { name: 'other', giteaRepo: 'other', targetClusterId: 'their-k3d' })).toEqual({ status: 400, body: { error: 'Deploy to the system cluster or one of your own clusters.' } });
    expect(repos.createProject).toHaveBeenCalledTimes(1);
  });

  it('accepts the system cluster for anyone', async () => {
    const { router } = setUp();
    expect((await post(router, '/', { name: 'demo', giteaRepo: 'demo', targetClusterId: systemCluster.id })).body).toMatchObject({ targetClusterId: systemCluster.id });
  });
});

describe('making a project that runs on one of the person\'s machines', () => {
  it('makes one with no repository, a local project with the device as its target', async () => {
    const { db, repos, channels, router } = setUp();
    await db.machines.saveLocalAgentDevice(device);
    const answer = await post(router, '/', { name: 'local-only', executionTargetDeviceId: 'dev-1', executionApproval: 'auto' });
    expect(answer.status).toBe(201);
    expect(answer.body).toMatchObject({ giteaRepo: '', appType: 'local', executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'auto' });
    expect(repos.createProject).not.toHaveBeenCalled();
    expect(channels.ensure).toHaveBeenCalledTimes(1);
  });

  it('keeps the folder and the egress rules it was given, and drops an approval that is not auto or plan', async () => {
    const { db, router } = setUp();
    await db.machines.saveLocalAgentDevice(device);
    const answer = await post(router, '/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1', executionTargetPath: ' apps/two ', executionTargetEgress: [{ host: 'registry.npmjs.org', ports: [443] }], executionApproval: 'whenever' });
    expect(answer.body).toMatchObject({ executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/two', egress: [{ host: 'registry.npmjs.org', ports: [443] }] } });
    expect((answer.body as ProjectMetadata).executionApproval).toBeUndefined();
  });

  it('refuses a device that is not the caller\'s, an egress rule that is not a host, and a device and folder another project holds', async () => {
    const { db, repos, router } = setUp();
    await db.machines.saveLocalAgentDevice({ ...device, id: 'not-mine', ownerId: 'someone-else' });
    await db.machines.saveLocalAgentDevice(device);
    expect(await post(router, '/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'not-mine' })).toEqual({ status: 400, body: { error: 'Unknown local execution device' } });
    expect((await post(router, '/', { name: 'demo', giteaRepo: 'demo', executionTargetDeviceId: 'dev-1', executionTargetEgress: [{ host: 'not a host' }] })).status).toBe(400);
    await db.projects.saveProjectInfo({ ...project, id: 'holder', giteaRepo: 'holder', executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/one' } });
    expect((await post(router, '/', { name: 'demo2', giteaRepo: 'demo2', executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/one' })).status).toBe(409);
    expect((await post(router, '/', { name: 'demo3', giteaRepo: 'demo3', executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/two' })).status).toBe(201);
    expect(repos.createProject).toHaveBeenCalledTimes(1);
  });

  it('ignores egress rules when no device is chosen', async () => {
    const { router } = setUp();
    const answer = await post(router, '/', { name: 'demo', giteaRepo: 'demo', executionTargetEgress: [{ host: 'registry.npmjs.org' }] });
    expect((answer.body as ProjectMetadata).executionTarget).toBeUndefined();
  });
});

describe('changing a project', () => {
  it('lets a project pick up a device of the caller\'s, with its folder', async () => {
    const { db, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.machines.saveLocalAgentDevice(device);
    const answer = await patch(router, '/proj-1', { executionTargetDeviceId: 'dev-1', executionTargetPath: 'apps/one' });
    expect(answer).toMatchObject({ status: 200, body: { executionTarget: { kind: 'local-device', deviceId: 'dev-1', path: 'apps/one' } } });
  });

  it('goes back to the cluster when the device is cleared', async () => {
    const { db, router } = setUp();
    await db.projects.saveProjectInfo({ ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect((await patch(router, '/proj-1', { executionTargetDeviceId: '' })).body).toMatchObject({ executionTarget: { kind: 'k8s' } });
  });

  it('lets a project keep its own device while changing its approval, and refuses one another project holds', async () => {
    const { db, router } = setUp();
    await db.machines.saveLocalAgentDevice(device);
    await db.projects.saveProjectInfo({ ...project, executionTarget: { kind: 'local-device', deviceId: 'dev-1' } });
    expect((await patch(router, '/proj-1', { executionTargetDeviceId: 'dev-1', executionApproval: 'plan' })).body).toMatchObject({ executionTarget: { kind: 'local-device', deviceId: 'dev-1' }, executionApproval: 'plan' });
    await db.projects.saveProjectInfo({ ...project, id: 'proj-2', giteaRepo: 'other' });
    expect((await patch(router, '/proj-2', { executionTargetDeviceId: 'dev-1' })).status).toBe(409);
  });

  it('refuses a device that is not the caller\'s and an egress rule that is not a host', async () => {
    const { db, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.machines.saveLocalAgentDevice({ ...device, id: 'not-mine', ownerId: 'someone-else' });
    await db.machines.saveLocalAgentDevice(device);
    expect((await patch(router, '/proj-1', { executionTargetDeviceId: 'not-mine' })).status).toBe(400);
    expect((await patch(router, '/proj-1', { executionTargetDeviceId: 'dev-1', executionTargetEgress: [{ host: 'not a host' }] })).status).toBe(400);
  });

  it('404s a project that is not the caller\'s', async () => {
    const { db, router } = setUp();
    await db.projects.saveProjectInfo({ ...project, giteaRepo: 'theirs', ownerId: 'someone-else' });
    expect(await patch(router, '/proj-1', { executionTargetDeviceId: 'dev-1' })).toEqual({ status: 404, body: { error: 'Project not found' } });
  });
});

describe('promoting a build', () => {
  it('starts the deployment of the project\'s run and answers 202 with the workflow', async () => {
    const { db, bridge, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    bridge.promoteProjectBuild.mockResolvedValue({ id: 'wf-1', resourceId: 'dep-1' } as Awaited<ReturnType<TemporalBridge['promoteProjectBuild']>>);
    expect(await post(router, '/proj-1/runs/run-1/promote')).toEqual({ status: 202, body: { message: 'Promoting build to deployment', workflowId: 'wf-1', deploymentId: 'dep-1' } });
    expect(bridge.promoteProjectBuild).toHaveBeenCalledWith(matches<ProjectMetadata>((made) => made.id === 'proj-1'), matches<PipelineRunMetadata>((given) => given.id === 'run-1'), CALLER.id);
  });

  it('refuses a project or run that is not there, and a project being deleted', async () => {
    const { db, bridge, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.projects.saveProjectInfo({ ...project, id: 'going', giteaRepo: 'going', removal: { startedAt: 't', requestedBy: CALLER.id } });
    await db.releases.savePipelineRunInfo(run());
    await db.releases.savePipelineRunInfo(run({ id: 'run-2', projectId: 'going' }));
    await db.releases.savePipelineRunInfo(run({ id: 'run-3', projectId: 'other' }));
    expect(await post(router, '/nope/runs/run-1/promote')).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(await post(router, '/proj-1/runs/run-3/promote')).toEqual({ status: 404, body: { error: 'Run not found' } });
    expect(await post(router, '/going/runs/run-2/promote')).toEqual({ status: 409, body: { error: 'This project is being deleted' } });
    expect(bridge.promoteProjectBuild).not.toHaveBeenCalled();
  });

  it('answers 400 with the reason when the promotion cannot start', async () => {
    const { db, bridge, router } = setUp();
    await db.projects.saveProjectInfo(project);
    await db.releases.savePipelineRunInfo(run());
    bridge.promoteProjectBuild.mockRejectedValue(new Error('waiting for the person to enter API_KEY'));
    expect(await post(router, '/proj-1/runs/run-1/promote')).toEqual({ status: 400, body: { error: 'waiting for the person to enter API_KEY' } });
  });
});

describe('deleting a project', () => {
  const preview: ProjectRemovalPreview & { state: { state: 'none' } } = { name: 'demo', trees: [], keptConversations: 0, builds: 0, apps: [], state: { state: 'none' } };

  it('shows what would go, or 404s a project that is not the caller\'s', async () => {
    const { removal, router } = setUp();
    removal.preview.calledWith(CALLER.id, 'proj-1').mockResolvedValue(preview);
    expect(await get(router, '/proj-1/removal')).toEqual({ status: 200, body: preview });
    expect(await get(router, '/nope/removal')).toEqual({ status: 404, body: { error: 'Project not found' } });
  });

  it('passes the typed name on and answers 202 with the state once it has started', async () => {
    const { removal, router } = setUp();
    removal.remove.mockResolvedValue({ ok: true, state: { state: 'running' } as never });
    expect(await callRouter(router, { method: 'DELETE', path: '/proj-1', body: { confirm: 'demo' } })).toEqual({ status: 202, body: { state: { state: 'running' } } });
    expect(removal.remove).toHaveBeenCalledWith(CALLER.id, 'proj-1', 'demo');
    await del(router, '/proj-1');
    expect(removal.remove).toHaveBeenLastCalledWith(CALLER.id, 'proj-1', '');
  });

  it('answers a refusal with its status and the refusal itself', async () => {
    const { removal, router } = setUp();
    removal.remove.mockResolvedValue({ ok: false, refusal: { status: 400, error: 'Type the project\'s name, demo, to confirm' } });
    expect(await del(router, '/proj-1', { confirm: 'x' })).toEqual({ status: 400, body: { status: 400, error: 'Type the project\'s name, demo, to confirm' } });
  });

  it('says projects cannot be deleted here when the server has no removal service', async () => {
    const { router } = setUp(false);
    expect(await get(router, '/proj-1/removal')).toEqual({ status: 404, body: { error: 'Projects cannot be deleted here' } });
    expect(await del(router, '/proj-1', { confirm: 'demo' })).toEqual({ status: 404, body: { error: 'Projects cannot be deleted here' } });
  });
});
