import { WorkflowNotFoundError, type Client, type WorkflowClient, type WorkflowExecutionDescription, type WorkflowExecutionInfo, type WorkflowHandle } from '@temporalio/client';
import { containing } from '../../platform/lib/test-matchers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { encryptValue, REOPEN_FIRST_MS, type ClusterMetadata, type DeploymentMetadata, type ProjectMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { buildPlanAt } from '../../releases/lib/build-plan.js';
import { ProvisionRefused } from '../lib/cluster-topology.js';
import type { ClusterAccess } from './ClusterAccess.js';
import type { ClusterService } from './ClusterService.js';
import { connectToTemporal, TemporalBridge, type TemporalConnect } from './TemporalBridge.js';

const KEY = 'temporal-bridge-test-key';
const SHA = '8c646f4f20f5fb217793c11ebbab0779f7d26757';
const project = { id: 'proj-1', name: 'notes', ownerId: 'u1', giteaOwner: 'acme', giteaRepo: 'notes', appType: 'gitapp', createdAt: 'then' } as ProjectMetadata;
const envKeys = ['NODE_ENV', 'HCLOUD_TOKEN', 'DIGITALOCEAN_TOKEN', 'MESH_LOGIN_SERVER'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

type Headscale = NonNullable<TemporalBridge['headscale']>;

function bridge(options: { headscale?: Headscale; io?: SocketServer; clusterService?: ClusterService } = {}) {
  const db = memoryDatabase();
  const workflow = mock<WorkflowClient>();
  const client = mock<Client>({ workflow });
  const generateKeypair = vi.fn(async (comment: string) => ({ privateKey: `PRIVATE-${comment}`, publicKey: `PUBLIC-${comment}` }));
  const connect = vi.fn<TemporalConnect>(async () => client);
  const instance = new TemporalBridge(db, options.io, KEY, options.clusterService, options.headscale, undefined, { connect, generateKeypair });
  return { db, workflow, client, connect, generateKeypair, instance, ready: () => { instance.client = client; return instance; } };
}

const startedWith = (workflow: ReturnType<typeof mock<WorkflowClient>>) => {
  const [, options] = workflow.start.mock.calls.at(-1) ?? [];
  return options as { workflowId: string; taskQueue: string; args: [Record<string, unknown>]; typedSearchAttributes: unknown } | undefined;
};

beforeEach(() => {
  process.env.NODE_ENV = 'development';
  delete process.env.HCLOUD_TOKEN;
  delete process.env.DIGITALOCEAN_TOKEN;
  delete process.env.MESH_LOGIN_SERVER;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe('connecting to Temporal', () => {
  it('is not ready until it has a client, and connects to the address given', async () => {
    const { instance, client, connect } = bridge();
    expect(instance.isReady()).toBe(false);
    expect(await instance.start('temporal.test:7233')).toBe(instance);
    expect(connect).toHaveBeenCalledWith({ address: 'temporal.test:7233' });
    expect(instance.client).toBe(client);
    expect(instance.isReady()).toBe(true);
  });

  it('connects to the default address when none is given', async () => {
    const { instance, connect } = bridge();
    await instance.start();
    expect(connect).toHaveBeenCalledWith({});
  });

  it('connects through the same path for anyone who needs a client of their own', async () => {
    const connect = vi.fn<TemporalConnect>(async () => mock<Client>());
    await connectToTemporal('other.test:7233', connect);
    expect(connect).toHaveBeenCalledWith({ address: 'other.test:7233' });
  });
});

describe('reading workflows for the Temporal page', () => {
  const info = (over: Partial<WorkflowExecutionInfo> = {}): WorkflowExecutionInfo => ({
    workflowId: 'w1', runId: 'r1', type: 'AgentRunWorkflow', taskQueue: 'engine', status: { name: 'RUNNING', code: 1 },
    startTime: new Date('2026-11-02T00:00:00Z'), closeTime: undefined, historyLength: 7,
    typedSearchAttributes: startedFor('ann').typedSearchAttributes as never, ...over,
  }) as WorkflowExecutionInfo;

  it('says Temporal is not reachable when the bridge has no client, rather than answering that nothing runs', async () => {
    const { instance } = bridge();
    await expect(instance.listWorkflows()).rejects.toMatchObject({ message: 'Temporal is not reachable', status: 503 });
    await expect(instance.countWorkflows()).rejects.toMatchObject({ status: 503 });
    await expect(instance.describeWorkflow('w1')).rejects.toMatchObject({ status: 503 });
    await expect(instance.getWorkflowHistory('w1')).rejects.toMatchObject({ status: 503 });
  });

  it('lists workflows as summaries, with whose they are, asking for the page size and query given', async () => {
    const { workflow, ready } = bridge();
    workflow.list.mockImplementation((() => (async function* () { yield info(); yield info({ workflowId: 'w2', status: { name: 'COMPLETED', code: 2 }, closeTime: new Date('2026-11-02T01:00:00Z'), typedSearchAttributes: undefined as never }); })()) as never);
    expect(await ready().listWorkflows('KoalaOwner = "ann"', 10)).toEqual([
      { workflowId: 'w1', runId: 'r1', type: 'AgentRunWorkflow', taskQueue: 'engine', status: 'RUNNING', startTime: '2026-11-02T00:00:00.000Z', closeTime: undefined, historyLength: 7, owner: 'ann' },
      expect.objectContaining({ workflowId: 'w2', status: 'COMPLETED', closeTime: '2026-11-02T01:00:00.000Z', owner: undefined }),
    ]);
    expect(workflow.list).toHaveBeenCalledWith({ query: 'KoalaOwner = "ann"', pageSize: 10 });
  });

  it('lists fifty at a time with no query unless told otherwise', async () => {
    const { workflow, ready } = bridge();
    workflow.list.mockImplementation((() => (async function* () { /* none */ })()) as never);
    await ready().listWorkflows();
    expect(workflow.list).toHaveBeenCalledWith({ pageSize: 50 });
  });

  it('counts workflows for a query', async () => {
    const { workflow, ready } = bridge();
    workflow.count.mockResolvedValue({ count: 12 } as never);
    expect(await ready().countWorkflows('ExecutionStatus="Running"')).toBe(12);
    expect(workflow.count).toHaveBeenCalledWith('ExecutionStatus="Running"');
  });

  it('raises a failure to count or describe with its reason instead of a zero or a missing workflow', async () => {
    const { workflow, ready } = bridge();
    workflow.count.mockRejectedValue(new Error('the visibility store did not answer'));
    workflow.getHandle.mockReturnValue(mock<ReturnType<WorkflowClient['getHandle']>>({
      describe: vi.fn().mockRejectedValue(new Error('deadline on the frontend')),
      fetchHistory: vi.fn().mockRejectedValue(new Error('deadline on the frontend')),
    }));
    const instance = ready();
    await expect(instance.countWorkflows()).rejects.toThrow('the visibility store did not answer');
    await expect(instance.describeWorkflow('w1')).rejects.toThrow('deadline on the frontend');
    await expect(instance.getWorkflowHistory('w1')).rejects.toThrow('deadline on the frontend');
  });

  it('describes a workflow, and answers a workflow Temporal does not have as missing', async () => {
    const { workflow, ready } = bridge();
    const found = mock<ReturnType<WorkflowClient['getHandle']>>();
    found.describe.mockResolvedValue(info() as unknown as WorkflowExecutionDescription);
    workflow.getHandle.calledWith('w1').mockReturnValue(found);
    const gone = mock<ReturnType<WorkflowClient['getHandle']>>();
    gone.describe.mockRejectedValue(new WorkflowNotFoundError('not found', 'w9', undefined));
    gone.fetchHistory.mockRejectedValue(new WorkflowNotFoundError('not found', 'w9', undefined));
    workflow.getHandle.calledWith('w9').mockReturnValue(gone);
    const instance = ready();
    expect(await instance.describeWorkflow('w1')).toMatchObject({ workflowId: 'w1', owner: 'ann' });
    expect(await instance.describeWorkflow('w9')).toBeNull();
    expect(await instance.getWorkflowHistory('w9')).toBeNull();
  });

  it('shows a workflow\'s history as events with the attributes of each, shortened', async () => {
    const { workflow, ready } = bridge();
    const handle = mock<ReturnType<WorkflowClient['getHandle']>>();
    handle.fetchHistory.mockResolvedValue({ events: [
      { eventId: 1, eventType: 1, eventTime: { seconds: 1 }, workflowExecutionStartedEventAttributes: { workflowType: { name: 'AgentRunWorkflow' } } },
      { eventId: 2, eventType: 5, eventTime: { seconds: 2 }, workflowExecutionCompletedEventAttributes: { result: 'x'.repeat(900) } },
      { eventId: 3, eventType: 9 },
    ] } as never);
    workflow.getHandle.mockReturnValue(handle);
    const events = await ready().getWorkflowHistory('w1') as { id: number; type: number; attributes: string | null }[];
    expect(events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(events[0]?.attributes).toBe('{"workflowType":{"name":"AgentRunWorkflow"}}');
    expect(events[1]?.attributes).toHaveLength(500);
    expect(events[2]?.attributes).toBeNull();
  });
});

describe('a push to a project', () => {
  it('records no build when the commit has nothing to build', async () => {
    const { instance, db, workflow } = bridge();
    instance.planBuild = (_project, sha) => buildPlanAt(async () => null, sha);
    expect(await instance.runPipeline(project, SHA, 'main')).toEqual({ event: 'nothing-to-build', reason: containing('there is no Dockerfile at') });
    expect(await db.releases.getPipelineRuns()).toEqual([]);
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('refuses anything but a commit hash, or a project with no repository, before it records or runs anything', async () => {
    const { instance, db } = bridge();
    await expect(instance.runPipeline(project, 'main; reboot', 'main')).rejects.toThrow('"main; reboot" is not a commit to build');
    await expect(instance.runPipeline({ ...project, giteaRepo: undefined } as unknown as ProjectMetadata, SHA, 'main')).rejects.toThrow('Project proj-1 has no repository to run a pipeline for.');
    expect(await db.releases.getPipelineRuns()).toEqual([]);
  });

  it('records the build as queued, starts its workflow on the cluster queue as the project\'s owner and tells the browsers', async () => {
    const io = mock<SocketServer>();
    const { ready, db, workflow } = bridge({ io });
    const answer = await ready().runPipeline(project, SHA, 'refs/heads/main');
    if (!('id' in answer)) throw new Error(`no build was started: ${answer.reason}`);
    const deal = answer;
    expect(deal.event).toBe('pipeline-run');
    expect(deal.id).toMatch(/^pipeline-run-notes-/);
    const [run] = await db.releases.getPipelineRuns();
    expect(run).toMatchObject({ projectId: 'proj-1', commitSha: SHA, ref: 'refs/heads/main', status: 'queued', temporalWorkflowId: deal.id });
    expect(deal.resourceId).toBe(run?.id);
    const started = startedWith(workflow);
    expect(started).toMatchObject({ workflowId: deal.id, taskQueue: 'cluster-ops-queue', args: [{ projectId: 'proj-1', giteaOwner: 'acme', giteaRepo: 'notes', commitSha: SHA, ref: 'refs/heads/main', runId: run?.id }], typedSearchAttributes: startedFor('u1').typedSearchAttributes });
    expect(io.emit).toHaveBeenCalledWith('pipeline-run-updated');
  });

  it('marks the project\'s last build queued', async () => {
    const { ready, db } = bridge();
    await db.projects.saveProjectInfo(project);
    await ready().runPipeline(project, SHA, 'main');
    expect((await db.projects.getProjects()).find((entry) => entry.id === 'proj-1')?.lastBuildStatus).toBe('queued');
  });
});

describe('changing an app\'s config', () => {
  const stored = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'd1', name: 'model', clusterId: 'c1', strategy: 'helm', status: 'running', appType: 'tabbyapi', ownerId: 'ann', ...over });

  it('says the deployment is not found when there is none', async () => {
    const { ready } = bridge();
    await expect(ready().updateConfigAndSync('nope', {})).rejects.toThrow('DeploymentMetadata not found (updateConfigAndSync)');
  });

  it('saves the patch with storage and settings merged into what the app had, then starts the sync workflow as its owner', async () => {
    const { ready, db, workflow } = bridge();
    await db.infrastructure.saveCluster({ id: 'c1', name: 'shared', provider: 'k3d', status: 'healthy' } as ClusterMetadata);
    await db.infrastructure.saveDeploymentInfo(stored({ storage: { data: '10Gi', cache: '5Gi' }, appSettings: { a: '1', b: '2' }, tabbyMaxSeqLen: 4096 }));
    const deal = await ready().updateConfigAndSync('d1', { storage: { data: '20Gi' }, appSettings: { b: '3' }, tabbyMaxSeqLen: 8192 });
    expect(deal.event).toBe('config-sync');
    expect(deal.id).toMatch(/^sync-config-model-/);
    const [saved] = await db.infrastructure.getDeployments();
    expect(saved).toMatchObject({ storage: { data: '20Gi', cache: '5Gi' }, appSettings: { a: '1', b: '3' }, tabbyMaxSeqLen: 8192, status: 'deploying', temporalWorkflowId: deal.id });
    expect(startedWith(workflow)).toMatchObject({ workflowId: deal.id, taskQueue: 'cluster-ops-queue', args: [{ name: 'model', clusterName: 'shared', provider: 'k3d', tabbyMaxSeqLen: 8192, storage: { data: '20Gi', cache: '5Gi' } }], typedSearchAttributes: startedFor('ann').typedSearchAttributes });
  });
});

describe('provisioning a cluster', () => {
  it('starts the provision workflow on the host queue, recording the cluster as provisioning for its owner', async () => {
    const { ready, db, workflow } = bridge();
    const deal = await ready().provision('lab', 'k3d', 'ann');
    expect(deal.event).toBe('cluster-provision');
    expect(deal.id).toMatch(/^cluster-provision-lab-/);
    const [cluster] = await db.infrastructure.getClusters();
    expect(cluster).toMatchObject({ name: 'lab', provider: 'k3d', status: 'provisioning', ownerId: 'ann', temporalWorkflowId: deal.id });
    expect(deal.resourceId).toBe(cluster?.id);
    expect(startedWith(workflow)).toMatchObject({ workflowId: deal.id, taskQueue: 'host-ops-queue', args: [{ name: 'lab', provider: 'k3d' }], typedSearchAttributes: startedFor('ann').typedSearchAttributes });
  });

  it('runs a provider that is not built as a local cluster on a dev box, and refuses it in production', async () => {
    const { ready, workflow } = bridge();
    await expect(ready().provision('lab', 'aws', 'ann')).resolves.toBeTruthy();
    expect(startedWith(workflow)?.args[0]).toMatchObject({ provider: 'aws' });
    process.env.NODE_ENV = 'production';
    await expect(ready().provision('lab2', 'aws', 'ann')).rejects.toBeInstanceOf(ProvisionRefused);
    await expect(ready().provision('lab3', 'aws', 'ann')).rejects.toThrow('Amazon Web Services is not available yet');
  });

  it('refuses a Hetzner cluster with no token, and gives one the person stored or the operator\'s to the workflow, with a key pair made for the VM', async () => {
    const { ready, db, workflow, generateKeypair } = bridge();
    await expect(ready().provision('vm', 'hetzner', 'ann', undefined)).rejects.toThrow('No Hetzner Cloud API token configured — add one under Cloud providers first');
    await db.accounts.saveUser({ id: 'ann', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { hetzner: { token: encryptValue('hcloud-mine', KEY) } } } as never);
    await ready().provision('vm', 'hetzner', 'ann', { serverType: 'cx22', location: 'fsn1', image: 'ubuntu-24.04' });
    expect(generateKeypair).toHaveBeenCalledWith('provisioning-vm');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ hcloudToken: 'hcloud-mine', hetznerServerType: 'cx22', hetznerLocation: 'fsn1', hetznerImage: 'ubuntu-24.04', hetznerSshPrivateKey: 'PRIVATE-provisioning-vm', hetznerSshPublicKey: 'PUBLIC-provisioning-vm' });
    const [cluster] = await db.infrastructure.getClusters();
    expect(cluster?.remoteSshPrivateKeyEnc).toMatch(/^v2:/);
    expect(cluster).toMatchObject({ hetznerServerType: 'cx22' });
  });

  it('gives an operator the Hetzner token from the environment', async () => {
    const { ready, db, workflow } = bridge();
    await db.accounts.saveUser({ id: 'op', email: 'o@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', roles: ['operator'] } as never);
    process.env.HCLOUD_TOKEN = 'hcloud-operator';
    await ready().provision('vm', 'hetzner', 'op');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ hcloudToken: 'hcloud-operator' });
  });

  it('refuses a DigitalOcean cluster with no token, and makes a Droplet with the token the person stored', async () => {
    const { ready, db, workflow, generateKeypair } = bridge();
    await expect(ready().provision('drop', 'do', 'ann')).rejects.toThrow('No DigitalOcean API token configured — add one under Cloud providers first');
    await db.accounts.saveUser({ id: 'ann', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { do: { token: encryptValue('do-mine', KEY) } } } as never);
    await ready().provision('drop', 'do', 'ann', { serverType: 's-2vcpu-4gb', location: 'syd1', image: 'ubuntu-24-04-x64' });
    expect(generateKeypair).toHaveBeenCalledWith('provisioning-drop');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ doToken: 'do-mine', doSize: 's-2vcpu-4gb', doRegion: 'syd1', doImage: 'ubuntu-24-04-x64', doSshPrivateKey: 'PRIVATE-provisioning-drop', doSshPublicKey: 'PUBLIC-provisioning-drop' });
  });

  it('counts a stored token that can no longer be decrypted as none', async () => {
    const { ready, db } = bridge();
    await db.accounts.saveUser({ id: 'ann', email: 'a@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', credentials: { do: { token: encryptValue('do-old', 'another-key') } } } as never);
    await expect(ready().provision('drop', 'do', 'ann')).rejects.toThrow('No DigitalOcean API token configured');
  });

  it('joins a new VM to the mesh with a key made for the person when the mesh is configured, and carries on without one when it cannot', async () => {
    const headscale = mock<Headscale>();
    headscale.createPreAuthKey.mockResolvedValue({ key: 'tskey-1' });
    const { ready, db, workflow } = bridge({ headscale });
    process.env.HCLOUD_TOKEN = 'hcloud-operator';
    await db.accounts.saveUser({ id: 'op', email: 'o@b.c', twoFactorEnabled: false, emailVerified: true, createdAt: 'x', roles: ['operator'] } as never);
    process.env.MESH_LOGIN_SERVER = 'https://mesh.example.com';
    await ready().provision('vm', 'hetzner', 'op');
    expect(headscale.createPreAuthKey).toHaveBeenCalledWith('op', { reusable: true, expirySeconds: 7200 });
    expect(startedWith(workflow)?.args[0]).toMatchObject({ meshLoginServer: 'https://mesh.example.com', meshPreAuthKey: 'tskey-1' });
    headscale.createPreAuthKey.mockRejectedValue(new Error('headscale down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ready().provision('vm2', 'hetzner', 'op');
    logged.mockRestore();
    expect(startedWith(workflow)?.args[0]).not.toHaveProperty('meshPreAuthKey');
  });
});

describe('following work to its end', () => {
  const closing = (ends: () => Promise<unknown>, status: string) => {
    const run = mock<WorkflowHandle>();
    run.result.mockImplementation(ends);
    run.describe.mockResolvedValue({ status: { name: status } } as WorkflowExecutionDescription);
    return run;
  };
  const deploying = { id: 'd1', name: 'shop', clusterId: 'c1', strategy: 'helm', status: 'deploying', temporalWorkflowId: 'wf-1', ownerId: 'u1' } as DeploymentMetadata;
  const statusOf = async (db: ReturnType<typeof bridge>['db'], id: string) => (await db.infrastructure.getDeployments()).find((dep) => dep.id === id)?.status;
  const firstFollowed = (instance: TemporalBridge) => {
    const original = instance.follow.bind(instance);
    let heard!: (first: { following: Promise<void> }) => void;
    const followed = new Promise<{ following: Promise<void> }>((resolve) => { heard = resolve; });
    const spy = vi.spyOn(instance, 'follow').mockImplementation((...args) => { const following = original(...args); heard({ following }); return following; });
    return { followed, spy };
  };

  it('marks an app running once Temporal says the workflow deploying it completed, and tells the browsers', async () => {
    const io = mock<SocketServer>();
    const { db, workflow, ready } = bridge({ io });
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);

    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', '', deploying);

    expect(await statusOf(db, 'd1')).toBe('running');
    expect(io.emit).toHaveBeenCalledWith('deployment-updated');
  });

  it('takes a workflow Temporal does not have as failed', async () => {
    const { db, workflow, ready } = bridge();
    workflow.getHandle.mockReturnValue(closing(async () => { throw new WorkflowNotFoundError('not found', 'wf-1', undefined); }, 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);

    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', '', deploying);

    expect(await statusOf(db, 'd1')).toBe('failed');
  });

  it('follows a workflow again after losing Temporal, waiting longer each time, and records how it ended once Temporal answers', async () => {
    const { db, workflow, ready } = bridge();
    const lost = vi.fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: connection refused'))
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: connection refused'))
      .mockResolvedValue({});
    workflow.getHandle.mockReturnValue(closing(lost, 'FAILED') as never);
    await db.infrastructure.saveDeployment(deploying);

    const following = ready().follow('wf-1', 'app-deploy', 'd1', 'shop', '', deploying);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(lost).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(lost, 'the second wait is twice the first').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    await following;

    expect(lost).toHaveBeenCalledTimes(3);
    expect(await statusOf(db, 'd1')).toBe('failed');
  });

  it('follows an app another process starts deploying as soon as its record names the workflow', async () => {
    const { db, workflow, ready } = bridge();
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    const instance = ready();
    const { followed } = firstFollowed(instance);
    await instance.followWork();

    await db.infrastructure.saveDeployment({ ...deploying, temporalWorkflowId: '' });
    await db.infrastructure.saveDeploymentInfo({ id: 'd1', temporalWorkflowId: 'wf-1' });
    await (await followed).following;

    expect(workflow.getHandle).toHaveBeenCalledWith('wf-1');
    expect(await statusOf(db, 'd1')).toBe('running');
    await instance.stop();
  });

  it('follows what was already going when it starts, and nothing that names no workflow or has ended', async () => {
    const { db, workflow, ready } = bridge();
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);
    await db.infrastructure.saveDeployment({ ...deploying, id: 'd2', name: 'blog', temporalWorkflowId: '' });
    await db.infrastructure.saveDeployment({ ...deploying, id: 'd3', name: 'wiki', status: 'running', temporalWorkflowId: 'wf-3' });
    const instance = ready();
    const { followed, spy } = firstFollowed(instance);

    await instance.followWork();
    await (await followed).following;

    expect(spy.mock.calls.map((call) => call[0])).toEqual(['wf-1']);
    expect(await statusOf(db, 'd1')).toBe('running');
    expect(await statusOf(db, 'd2')).toBe('deploying');
    await instance.stop();
  });
});

describe('checking each app on its cluster', () => {
  const machine: ClusterMetadata = { id: 'machine-desk', name: 'machine-desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'u1' };
  const running = (over: Partial<DeploymentMetadata> & Pick<DeploymentMetadata, 'id' | 'name'>): DeploymentMetadata =>
    ({ clusterId: 'machine-desk', strategy: 'helm', appType: 'wordpress', ownerId: 'u1', status: 'running', createdAt: 'then', ...over }) as DeploymentMetadata;
  const listOf = (items: unknown[]): string => JSON.stringify({ items });
  const readyPod = { metadata: { name: 'web' }, status: { phase: 'Running', containerStatuses: [{ name: 'web', ready: true, restartCount: 0, state: { running: {} } }] } };

  function checking(namespaces: Array<string | Record<string, unknown>>) {
    const access = mock<ClusterAccess>();
    const reach = { clusterId: 'machine-desk', kind: 'machine' as const, kubeconfig: 'k' };
    access.reach.mockResolvedValue(reach);
    access.kubectl.mockImplementation(async (_reach, args) => (args[1] === 'namespaces' ? listOf(namespaces.map((name) => (typeof name === 'string' ? { metadata: { name } } : name))) : listOf([readyPod])));
    const clusterService = mock<ClusterService>();
    Object.assign(clusterService, { access });
    const io = mock<SocketServer>();
    const made = bridge({ clusterService, io });
    return { ...made, access, io };
  }

  it('marks an app whose namespace is not on its cluster unhealthy with why, keeping its record, and reads the namespaces once a cluster', async () => {
    const { db, instance, access, io } = checking(['shop-1a2b3c']);
    await db.infrastructure.saveCluster(machine);
    await db.infrastructure.saveDeploymentInfo(running({ id: 'shop', name: 'Shop', namespace: 'shop-1a2b3c' }));
    await db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f' }));
    await instance.checkApps();
    const byId = Object.fromEntries((await db.infrastructure.getDeployments()).map((dep) => [dep.id, [dep.status, dep.healthReason]]));
    expect(byId).toEqual({ shop: ['running', undefined], gone: ['unhealthy', 'its namespace gone-4d5e6f is not on its cluster, so nothing of it runs there; destroy the app or deploy it again'] });
    expect(access.kubectl.mock.calls.filter(([, args]) => args[1] === 'namespaces')).toHaveLength(1);
    expect(io.emit).toHaveBeenCalledWith('deployment-updated');
  });

  it('says nothing again for an app already marked missing, and judges it by its pods once its namespace is back', async () => {
    const missing = checking([]);
    await missing.db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f', status: 'unhealthy', healthReason: 'its namespace gone-4d5e6f is not on its cluster, so nothing of it runs there; destroy the app or deploy it again' }));
    await missing.instance.checkApps();
    expect(missing.io.emit).not.toHaveBeenCalled();
    const back = checking(['gone-4d5e6f']);
    await back.db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f', status: 'unhealthy', healthReason: 'its namespace gone-4d5e6f is not on its cluster' }));
    await back.instance.checkApps();
    expect((await back.db.infrastructure.getDeployments())[0]?.status).toBe('running');
  });

  it('says on an app being removed what Kubernetes waits on to delete its namespace, and clears it once that is gone', async () => {
    const held = { metadata: { name: 'shop-1a2b3c' }, status: { phase: 'Terminating', conditions: [{ type: 'NamespaceFinalizersRemaining', status: 'True', message: 'Some content in the namespace has finalizers remaining: example.com/hold in 1 resource instances' }] } };
    const holding = checking([held]);
    await holding.db.infrastructure.saveDeploymentInfo(running({ id: 'shop', name: 'Shop', namespace: 'shop-1a2b3c', status: 'destroying' }));
    await holding.instance.checkApps();
    expect((await holding.db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'destroying', healthReason: 'it is being removed, and Kubernetes is waiting on: Some content in the namespace has finalizers remaining: example.com/hold in 1 resource instances' });
    const gone = checking([]);
    await gone.db.infrastructure.saveDeploymentInfo(running({ id: 'shop', name: 'Shop', namespace: 'shop-1a2b3c', status: 'destroying', healthReason: 'it is being removed, and Kubernetes is waiting on: x' }));
    await gone.instance.checkApps();
    expect((await gone.db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'destroying' });
    expect((await gone.db.infrastructure.getDeployments())[0]).not.toHaveProperty('healthReason');
  });

  it('never makes again an app deleted while the pass read its cluster', async () => {
    const { db, instance, access } = checking([]);
    await db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f' }));
    const list = access.kubectl.getMockImplementation()!;
    access.kubectl.mockImplementation(async (reach, args, input) => {
      await db.infrastructure.deleteDeployment('gone');
      return list(reach, args, input);
    });
    await instance.checkApps();
    expect(await db.infrastructure.getDeployments()).toEqual([]);
  });
});
