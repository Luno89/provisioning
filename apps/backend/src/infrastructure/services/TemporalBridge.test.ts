import { workFor } from '@koala/engine-core/work-for';
import { WorkflowNotFoundError, type Client, type WorkflowClient, type WorkflowExecutionDescription, type WorkflowExecutionInfo, type WorkflowHandle } from '@temporalio/client';
import { containing } from '../../platform/lib/test-matchers.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { Server as SocketServer } from 'socket.io';
import { REOPEN_FIRST_MS, type ClusterMetadata, type DeploymentMetadata, type MemoryIndexReach, type Off, type ProjectMetadata } from '../../platform/index.js';
import { unreportedReach } from '../../platform/testing/memory-index.js';
import { http, HttpResponse } from 'msw';
import { interceptHttp } from '../../platform/testing/http.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { buildPlanAt } from '../../releases/lib/build-plan.js';
import type { ClusterAccess } from './ClusterAccess.js';
import type { ClusterService } from './ClusterService.js';
import { connectToTemporal, TemporalBridge, type TemporalConnect } from './TemporalBridge.js';
import { testDataDir } from '../../platform/testing/data-dir.js';
import type { ToolCallParsers } from '../../models/index.js';

const KEY = 'temporal-bridge-test-key';
const SHA = '8c646f4f20f5fb217793c11ebbab0779f7d26757';
const project = { id: 'proj-1', name: 'notes', ownerId: 'u1', giteaOwner: 'acme', giteaRepo: 'notes', appType: 'gitapp', createdAt: 'then' } as ProjectMetadata;
const envKeys = ['NODE_ENV'] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

function ownerBrowsers() {
  const io = mock<SocketServer>();
  const told = mock<ReturnType<SocketServer['to']>>();
  io.to.mockReturnValue(told);
  return { io, told };
}

function bridge(options: { io?: SocketServer; clusterService?: ClusterService; memoryIndex?: MemoryIndexReach | Off } = {}) {
  const db = memoryDatabase();
  const workflow = mock<WorkflowClient>();
  const client = mock<Client>({ workflow });
  const connect = vi.fn<TemporalConnect>(async () => client);
  const instance = new TemporalBridge(db, testDataDir(), options.io, KEY, options.clusterService, { connect, memoryIndex: options.memoryIndex });
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

  it('does not take recovery as done while Temporal cannot be reached, so whoever started it tries again and then follows the runs', async () => {
    const { instance, connect, client } = bridge();
    const unreachable = Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });
    connect.mockRejectedValueOnce(unreachable);
    await expect(instance.startActiveWorkflowRecovery()).rejects.toBe(unreachable);
    expect(instance.isReady()).toBe(false);
    await instance.startActiveWorkflowRecovery();
    expect(instance.client).toBe(client);
    await instance.stop();
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

  it('starts the build as work for its project, so deleting the project refuses and stops what the build still does', async () => {
    const { ready, workflow } = bridge();
    let during: unknown;
    workflow.start.mockImplementation((async () => { during = workFor(); return mock(); }) as never);
    await ready().runPipeline(project, SHA, 'main');
    expect(during).toEqual({ project: 'proj-1' });
  });

  it('marks the project\'s last build queued', async () => {
    const { ready, db } = bridge();
    await db.projects.saveProjectInfo(project);
    await ready().runPipeline(project, SHA, 'main');
    expect((await db.projects.getProjects()).find((entry) => entry.id === 'proj-1')?.lastBuildStatus).toBe('queued');
  });
});

describe('changing an app\'s config', () => {
  const stored = (over: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id: 'd1', name: 'model', clusterId: 'c1', strategy: 'helm', status: 'running', appType: 'tabbyapi', ownerId: 'ann', deploymentId: 'd1a2b3c4', ...over });

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

describe('deciding a vLLM app\'s tool calling for a deploy', () => {
  it('asks the tool call parsers it was given, and says plainly when it was given none', async () => {
    const toolCalling = mock<Pick<ToolCallParsers, 'decide'>>();
    toolCalling.decide.mockResolvedValue({ enabled: true, parser: 'hermes' } as never);
    const given = new TemporalBridge(memoryDatabase(), testDataDir(), undefined, KEY, undefined, { toolCalling });
    const app = { vllmModel: 'Qwen/Qwen2.5-0.5B-Instruct' } as never;
    expect(await given.appDeployDeps().toolCalling.decide(app, { newApp: true, ownerId: 'u1' })).toEqual({ enabled: true, parser: 'hermes' });
    expect(toolCalling.decide).toHaveBeenCalledWith(app, { newApp: true, ownerId: 'u1' });
    const none = new TemporalBridge(memoryDatabase(), testDataDir(), undefined, KEY);
    await expect(none.appDeployDeps().toolCalling.decide(app, { newApp: true, ownerId: 'u1' })).rejects.toThrow('a vLLM app\'s tool calling is decided by the tool call parsers, and this bridge was given none');
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

  it('marks an app running once Temporal says the workflow deploying it completed, and tells its owner\'s browsers', async () => {
    const { io, told } = ownerBrowsers();
    const { db, workflow, ready } = bridge({ io });
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    await db.infrastructure.saveDeployment(deploying);

    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);

    expect(await statusOf(db, 'd1')).toBe('running');
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(told.emit).toHaveBeenCalledWith('deployment-updated');
    expect(io.emit).not.toHaveBeenCalledWith('deployment-updated');
  });

  it('keeps why an app failed on it, and clears it when a later deploy of it succeeds', async () => {
    const { db, workflow, ready } = bridge();
    await db.infrastructure.saveDeployment({ ...deploying, failure: 'the GPUs could not be readied' });
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    await ready().follow('wf-1', 'app-deploy', 'd1', 'shop', deploying);
    const stored = (await db.infrastructure.getDeployments()).find((entry) => entry.id === 'd1');
    expect(stored?.status).toBe('running');
    expect(stored).not.toHaveProperty('failure');
  });

  it('removes an app once the workflow destroying it ends, tells its owner\'s browsers, and a model it served is nobody\'s default any more', async () => {
    const { io, told } = ownerBrowsers();
    const { db, workflow, ready } = bridge({ io });
    const person = { email: 'u1@example.com', twoFactorEnabled: false, emailVerified: true, createdAt: '2026-11-01T00:00:00Z' };
    await db.accounts.saveUser({ id: 'u1', ...person, defaultModelId: 'd1' });
    await db.accounts.saveUser({ id: 'u2', ...person, email: 'u2@example.com', defaultModelId: 'd2' });
    await db.infrastructure.saveDeployment({ ...deploying, status: 'destroying', appType: 'vllm' });
    workflow.getHandle.mockReturnValue(closing(async () => ({}), 'COMPLETED') as never);
    await ready().follow('wf-1', 'app-destroy', 'd1', 'shop', deploying);
    expect(await statusOf(db, 'd1')).toBeUndefined();
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(told.emit).toHaveBeenCalledWith('resource-destroyed', { id: 'd1', type: 'deployment', name: 'shop' });
    expect((await db.accounts.getUserById('u1'))?.defaultModelId).toBeUndefined();
    expect((await db.accounts.getUserById('u2'))?.defaultModelId).toBe('d2');
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

  it('tells the owner\'s browsers the moment another process\'s record names the work it started, before it ends', async () => {
    const { io, told } = ownerBrowsers();
    const { db, workflow, ready } = bridge({ io });
    workflow.getHandle.mockReturnValue(closing(() => new Promise<never>(() => undefined), 'RUNNING') as never);
    const instance = ready();
    await instance.followWork();

    await db.infrastructure.saveDeployment({ ...deploying, status: 'destroying', temporalWorkflowId: '' });
    expect(told.emit).not.toHaveBeenCalled();
    await db.infrastructure.saveDeploymentInfo({ id: 'd1', temporalWorkflowId: 'wf-1' });

    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(told.emit).toHaveBeenCalledWith('deployment-updated');
    expect(await statusOf(db, 'd1')).toBe('destroying');
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
    const { io, told } = ownerBrowsers();
    const made = bridge({ clusterService, io });
    return { ...made, access, io, told };
  }

  it('marks an app whose namespace is not on its cluster unhealthy with why, keeping its record, and reads the namespaces once a cluster', async () => {
    const { db, instance, access, io, told } = checking(['shop-1a2b3c']);
    await db.infrastructure.saveCluster(machine);
    await db.infrastructure.saveDeploymentInfo(running({ id: 'shop', name: 'Shop', namespace: 'shop-1a2b3c' }));
    await db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f' }));
    await instance.checkApps();
    const byId = Object.fromEntries((await db.infrastructure.getDeployments()).map((dep) => [dep.id, [dep.status, dep.healthReason]]));
    expect(byId).toEqual({ shop: ['running', undefined], gone: ['unhealthy', 'its namespace gone-4d5e6f is not on its cluster, so nothing of it runs there; destroy the app or deploy it again'] });
    expect(access.kubectl.mock.calls.filter(([, args]) => args[1] === 'namespaces')).toHaveLength(1);
    expect(io.to).toHaveBeenCalledWith('user:u1');
    expect(told.emit).toHaveBeenCalledWith('deployment-updated');
  });

  it('says nothing again for an app already marked missing, and judges it by its pods once its namespace is back', async () => {
    const missing = checking([]);
    await missing.db.infrastructure.saveDeploymentInfo(running({ id: 'gone', name: 'Gone', namespace: 'gone-4d5e6f', status: 'unhealthy', healthReason: 'its namespace gone-4d5e6f is not on its cluster, so nothing of it runs there; destroy the app or deploy it again' }));
    await missing.instance.checkApps();
    expect(missing.io.to).not.toHaveBeenCalled();
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

  it('never lets a registry failure change a status: an MCP server whose probe fails leaves every app as its pods alone would', async () => {
    const world = async (probe: () => Promise<{ tools: number }>) => {
      const made = checking(['tools-1a2b3c', 'blog-4d5e6f']);
      await made.db.infrastructure.saveCluster(machine);
      await made.db.infrastructure.saveDeploymentInfo(running({ id: 'tools', name: 'Tools', appType: 'gitapp', namespace: 'tools-1a2b3c' }));
      await made.db.infrastructure.saveDeploymentInfo(running({ id: 'blog', name: 'Blog', namespace: 'blog-4d5e6f', status: 'unhealthy', healthReason: 'its pod was not ready' }));
      vi.spyOn(made.instance as unknown as { mcpProbes: () => Promise<{ tools: number }> }, 'mcpProbes').mockImplementation(probe);
      await made.instance.checkApps();
      return Object.fromEntries((await made.db.infrastructure.getDeployments()).map((dep) => [dep.id, [dep.status, dep.healthReason ?? '']]));
    };

    const failed = await world(async () => { throw new Error('the MCP registry did not answer'); });
    const silent = await world(async () => ({ tools: 3 }));

    expect(failed).toEqual(silent);
    expect(failed).toEqual({ tools: ['running', ''], blog: ['running', ''] });
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
  const app = { id: 'shop', name: 'shop', namespace: 'shop-1a2b3c', clusterId: 'machine-desk', strategy: 'native', appType: 'wordpress', ownerId: 'u1', status: 'running', deploymentId: 'shop1a2b' } as DeploymentMetadata;

  function starting() {
    const access = mock<ClusterAccess>();
    access.reach.mockResolvedValue(DESK);
    access.handOver.mockResolvedValue({ clusterId: 'machine-desk', machine: { deviceId: 'desk' } });
    const clusterService = mock<ClusterService>();
    Object.assign(clusterService, { access });
    clusterService.isKoalasCluster.calledWith('machine-desk').mockReturnValue(true);
    clusterService.ownCluster.mockResolvedValue({ id: 'machine-desk', name: 'desk', provider: 'machine', machineId: 'desk', status: 'healthy', ownerId: 'u1' } as never);
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

  it('destroys an app still deploying by cancelling its deploy, waiting for it to end, then destroying it as any app is', async () => {
    const { db, ready, workflow } = starting();
    const order: string[] = [];
    const deploy = {
      cancel: vi.fn(async () => { order.push('cancel'); }),
      result: vi.fn(async () => { throw Object.assign(new Error('Workflow execution cancelled'), { name: 'WorkflowFailedError' }); }),
      describe: vi.fn(async () => ({ status: { name: order.includes('cancel') ? 'CANCELLED' : 'RUNNING' } })),
    };
    workflow.getHandle.mockImplementation(((id: string) => (id === 'wf-deploy' ? deploy : mock())) as never);
    workflow.start.mockImplementation((async () => { order.push(`start, the app ${(await db.infrastructure.getDeployments())[0]?.status}`); return mock(); }) as never);
    await db.infrastructure.saveDeploymentInfo({ ...app, status: 'deploying', temporalWorkflowId: 'wf-deploy' });
    await ready().destroyApp('shop');
    expect(order).toEqual(['cancel', 'start, the app failed']);
    expect(startedWith(workflow)?.args[0]).toMatchObject({ deploymentId: 'shop1a2b', clusterName: 'desk' });
    expect((await db.infrastructure.getDeployments())[0]?.status).toBe('destroying');
  });

  it('keeps an app as it was when its destroy cannot be started, and says why', async () => {
    const { db, ready, workflow } = starting();
    workflow.start.mockRejectedValue(new Error('Temporal is not answering'));
    await db.infrastructure.saveDeploymentInfo(app);
    await expect(ready().destroyApp('shop')).rejects.toThrow('Temporal is not answering');
    expect((await db.infrastructure.getDeployments())[0]).toMatchObject({ status: 'running' });
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

  it('starts the removal, resize and settings sync of a project\'s app as work for that project, and of any other app for no project', async () => {
    const { db, ready, workflow } = starting();
    const seen: unknown[] = [];
    workflow.start.mockImplementation((async () => { seen.push(workFor()); return mock(); }) as never);
    workflow.getHandle.mockReturnValue({
      cancel: vi.fn(async () => undefined),
      result: vi.fn(async () => { throw Object.assign(new Error('Workflow execution cancelled'), { name: 'WorkflowFailedError' }); }),
      describe: vi.fn(async () => ({ status: { name: 'CANCELLED' } })),
    } as never);
    await db.infrastructure.saveDeploymentInfo({ ...app, gitappProjectId: 'p1' });
    await ready().resizeDisk('shop', { data: '20Gi' });
    await ready().syncConfig('shop');
    await ready().destroyApp('shop');
    await db.infrastructure.saveDeploymentInfo({ ...app, id: 'blog', name: 'blog' });
    await ready().destroyApp('blog');
    expect(seen).toEqual([{ project: 'p1' }, { project: 'p1' }, { project: 'p1' }, undefined]);
  });

  it('starts a crawl kept to a project as work for that project', async () => {
    const { ready, workflow } = starting();
    const seen: unknown[] = [];
    workflow.start.mockImplementation((async () => { seen.push(workFor()); return mock(); }) as never);
    await ready().startIngest({ ownerId: 'u1', url: 'https://example.com', projectId: 'p1' });
    await ready().startIngest({ ownerId: 'u1', url: 'https://example.com' });
    expect(seen).toEqual([{ project: 'p1' }, undefined]);
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

describe('consolidating everyone\'s memories', () => {
  const lesson = (id: string, ownerId: string, days: number) => ({
    id, ownerId, category: 'environment_facts' as const, scope: 'global' as const, status: 'active' as const, title: 'DNS lives at Cloudflare', text: 'The person manages DNS at Cloudflare.',
    createdAt: new Date(Date.now() - days * 86_400_000).toISOString(), updatedAt: new Date(Date.now() - days * 86_400_000).toISOString(),
  });

  const INDEX = 'http://index.bridge.test';
  const server = interceptHttp();

  it('retires each person\'s own duplicates, never one person\'s for another\'s, through the memory index, and keeps what the pass found', async () => {
    const asked: string[] = [];
    server.use(http.all(`${INDEX}/*`, ({ request }) => { asked.push(new URL(request.url).pathname); return HttpResponse.json({ result: [] }); }));
    const { db, instance } = bridge({ memoryIndex: unreportedReach({ index: { base: INDEX }, vectors: { base: INDEX, apiKey: 'k' }, embeddings: { base: INDEX } }) });
    for (const item of [lesson('a1', 'u1', 8), lesson('a2', 'u1', 6), lesson('b1', 'u2', 7)]) await db.memory.saveMemory(item);

    await instance.consolidateMemoryBank();

    expect((await db.memory.getMemories()).map((item) => [item.id, item.mergedInto ?? 'current']).sort()).toEqual([['a1', 'a2'], ['a2', 'current'], ['b1', 'current']]);
    expect(instance.lastConsolidation).toMatchObject({ live: 1 });
    expect(asked).toContain('/api/v1/koala-memory/delete-tasks');
  });

  it('keeps every person\'s memories, saying why, where no memory index was given', async () => {
    const { db, instance } = bridge({ memoryIndex: { off: 'root keeps no memories and crawls no corpus, so it has no memory index; each instance does' } });
    for (const item of [lesson('c1', 'u3', 8), lesson('c2', 'u3', 6)]) await db.memory.saveMemory(item);

    await instance.consolidateMemoryBank();

    expect((await db.memory.getMemories()).every((item) => !item.mergedInto)).toBe(true);
    expect(await db.memory.getKeepingState('u3')).toMatchObject({ state: 'down', reason: 'memories cannot be kept here: root keeps no memories and crawls no corpus, so it has no memory index; each instance does' });
  });
});
