import { WorkflowNotFoundError, type Client, type WorkflowClient, type WorkflowExecutionDescription, type WorkflowExecutionInfo, type WorkflowHandle } from '@temporalio/client';
import { containing } from '../../platform/lib/test-matchers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { REOPEN_FIRST_MS, type ClusterMetadata, type DeploymentMetadata, type ProjectMetadata } from '../../platform/index.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { buildPlanAt } from '../../releases/lib/build-plan.js';
import type { ClusterAccess } from './ClusterAccess.js';
import type { ClusterService } from './ClusterService.js';
import { connectToTemporal, TemporalBridge, type TemporalConnect } from './TemporalBridge.js';

const KEY = 'temporal-bridge-test-key';
const SHA = '8c646f4f20f5fb217793c11ebbab0779f7d26757';
const project = { id: 'proj-1', name: 'notes', ownerId: 'u1', giteaOwner: 'acme', giteaRepo: 'notes', appType: 'gitapp', createdAt: 'then' } as ProjectMetadata;
const envKeys = ['NODE_ENV'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function bridge(options: { io?: SocketServer; clusterService?: ClusterService } = {}) {
  const db = memoryDatabase();
  const workflow = mock<WorkflowClient>();
  const client = mock<Client>({ workflow });
  const connect = vi.fn<TemporalConnect>(async () => client);
  const instance = new TemporalBridge(db, options.io, KEY, options.clusterService, { connect });
  return { db, workflow, client, connect, instance, ready: () => { instance.client = client; return instance; } };
}

const startedWith = (workflow: ReturnType<typeof mock<WorkflowClient>>) => {
  const [, options] = workflow.start.mock.calls.at(-1) ?? [];
  return options as { workflowId: string; taskQueue: string; args: [Record<string, unknown>]; typedSearchAttributes: unknown } | undefined;
};

beforeEach(() => {
  process.env.NODE_ENV = 'development';
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
    const access = mock<ClusterAccess>();
    access.handOver.mockResolvedValue({ clusterId: 'c1', reach: { clusterId: 'c1', kind: 'koala' } });
    const clusterService = mock<ClusterService>();
    Object.assign(clusterService, { access });
    const { ready, db, workflow } = bridge({ clusterService });
    await db.infrastructure.saveCluster({ id: 'c1', name: 'shared', provider: 'machine', machineId: 'shared', status: 'healthy' });
    await db.infrastructure.saveDeploymentInfo(stored({ storage: { data: '10Gi', cache: '5Gi' }, appSettings: { a: '1', b: '2' }, tabbyMaxSeqLen: 4096 }));
    const deal = await ready().updateConfigAndSync('d1', { storage: { data: '20Gi' }, appSettings: { b: '3' }, tabbyMaxSeqLen: 8192 });
    expect(deal.event).toBe('config-sync');
    expect(deal.id).toMatch(/^sync-config-model-/);
    const [saved] = await db.infrastructure.getDeployments();
    expect(saved).toMatchObject({ storage: { data: '20Gi', cache: '5Gi' }, appSettings: { a: '1', b: '3' }, tabbyMaxSeqLen: 8192, status: 'deploying', temporalWorkflowId: deal.id });
    expect(startedWith(workflow)).toMatchObject({ workflowId: deal.id, taskQueue: 'cluster-ops-queue', args: [{ name: 'model', clusterName: 'shared', reach: { clusterId: 'c1', kind: 'koala' }, tabbyMaxSeqLen: 8192, storage: { data: '20Gi', cache: '5Gi' } }], typedSearchAttributes: startedFor('ann').typedSearchAttributes });
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

    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);

    expect(await statusOf(db, 'd1')).toBe('running');
    expect(io.emit).toHaveBeenCalledWith('deployment-updated');
  });

  it('takes a workflow Temporal does not have as failed', async () => {
    const { db, workflow, ready } = bridge();
    workflow.getHandle.mockReturnValue(closing(async () => { throw new WorkflowNotFoundError('not found', 'wf-1', undefined); }, 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);

    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);

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

    const following = ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(lost).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(lost, 'the second wait is twice the first').toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    await following;

    expect(lost).toHaveBeenCalledTimes(3);
    expect(await statusOf(db, 'd1')).toBe('failed');
  });

  it('reads a finished deploy\'s verdict again while Temporal does not answer, never taking the app as running unread', async () => {
    const { db, workflow, ready } = bridge();
    const result = vi.fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('14 UNAVAILABLE: connection refused'))
      .mockResolvedValue({ workload: 'unhealthy', workloadReason: 'its pod cannot pull its image' });
    workflow.getHandle.mockReturnValue(closing(result, 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);

    const following = ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);
    await vi.advanceTimersByTimeAsync(0);
    expect(await statusOf(db, 'd1')).toBe('deploying');
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    await following;

    expect(result).toHaveBeenCalledTimes(3);
    expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'unhealthy', healthReason: 'its pod cannot pull its image' });
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

describe('the work the bridge starts on an app\'s cluster is handed how to reach it', () => {
  const DESK = { clusterId: 'machine-desk', kind: 'machine' as const, kubeconfig: 'apiVersion: v1' };
  const app = { id: 'shop', name: 'shop', namespace: 'shop-1a2b3c', clusterId: 'machine-desk', strategy: 'native', appType: 'wordpress', ownerId: 'u1', status: 'running' } as DeploymentMetadata;

  function starting() {
    const access = mock<ClusterAccess>();
    access.reach.mockResolvedValue(DESK);
    access.handOver.mockResolvedValue({ clusterId: 'machine-desk', machine: { deviceId: 'desk' } });
    const clusterService = mock<ClusterService>();
    Object.assign(clusterService, { access });
    const made = bridge({ clusterService });
    made.workflow.start.mockResolvedValue(mock<Awaited<ReturnType<WorkflowClient['start']>>>());
    return { ...made, access };
  }

  it('hands a removal the machine to start, with the app that leaves it', async () => {
    const { db, ready, workflow, access } = starting();
    await db.infrastructure.saveDeploymentInfo(app);
    await ready().destroyApp('shop');
    expect(access.handOver).toHaveBeenCalledWith('machine-desk');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ clusterId: 'machine-desk', machine: { deviceId: 'desk', leaving: 'shop' } });
    expect(startedWith(workflow)?.args[0]).not.toHaveProperty('kubeconfigPath');
  });

  it('hands a disk resize and a settings sync the machine to start, as a deploy and a removal are, so a machine stopped until something runs on it is started for them', async () => {
    const { db, ready, workflow, access } = starting();
    await db.infrastructure.saveDeploymentInfo(app);
    await ready().resizeDisk('shop', { data: '20Gi' });
    expect(startedWith(workflow)?.args[0]).toMatchObject({ clusterId: 'machine-desk', machine: { deviceId: 'desk' } });
    await ready().syncConfig('shop');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ clusterId: 'machine-desk', machine: { deviceId: 'desk' } });
    expect(access.handOver.mock.calls).toEqual([['machine-desk'], ['machine-desk']]);
    expect(access.reach).not.toHaveBeenCalled();
  });

  it('hands them the reach when the cluster needs no starting', async () => {
    const { db, ready, workflow, access } = starting();
    access.handOver.mockResolvedValue({ clusterId: 'machine-desk', reach: DESK });
    await db.infrastructure.saveDeploymentInfo(app);
    await ready().syncConfig('shop');
    expect(startedWith(workflow)?.args[0]).toMatchObject({ clusterId: 'machine-desk', reach: DESK });
    expect(startedWith(workflow)?.args[0]).not.toHaveProperty('machine');
  });

  it('starts nothing and changes no record when the app\'s cluster cannot be reached', async () => {
    const { db, ready, workflow, access } = starting();
    await db.infrastructure.saveDeploymentInfo(app);
    access.handOver.mockRejectedValue(Object.assign(new Error('desk is no machine of this account'), { name: 'ClusterUnreachable' }));
    await expect(ready().resizeDisk('shop', { data: '20Gi' })).rejects.toThrow('no machine of this account');
    expect(workflow.start).not.toHaveBeenCalled();
    expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'running' });
  });
});
