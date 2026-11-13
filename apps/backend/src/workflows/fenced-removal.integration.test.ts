import { activityInterceptors, WORKER_DEFAULTS } from '@koala/engine-core';
import { withWorkFor } from '@koala/engine-core/work-for';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId } from '../accounts/lib/account-removal.js';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { createAccountRemovalActivities, NO_MESH_HERE, type AccountRemovalDeps } from '../activities/RemoveAccountActivities.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from '../activities/RemoveProjectActivities.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { minioObjectStore } from '../files/services/ObjectStore.js';
import { testBucket } from '../files/testing/real-minio.js';
import { PROJECT_REMOVAL_PROGRESS_QUERY, REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { releaseRunWorkflowId } from '../releases/lib/release-run.js';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { stopIfRunning } from '../platform/lib/stop-workflow.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { holdFences } from '../platform/wiring/fences.js';
import type { FenceWatch } from '../platform/services/FenceWatch.js';
import { bundled, realTemporalEnvironment } from './temporal-test-env.js';

let env: TestWorkflowEnvironment;
let db: MongoDB;
let watch: FenceWatch;
const objects = minioObjectStore({ ...inject('minio'), bucket: testBucket() });
const at = '2026-11-13T10:00:00.000Z';

beforeAll(async () => {
  env = await realTemporalEnvironment();
  db = await testDatabase();
  watch = await holdFences('worker-engine', db.platform);
}, 120_000);

afterAll(async () => {
  await watch?.stop();
  await env?.teardown();
});

interface Straggler {
  started: Promise<void>;
  letGo: () => void;
  outcome: Promise<string[]>;
}

function straggler(write: (args: { ownerId: string; projectId?: string | undefined }) => Promise<string[]>): Straggler & { activity: (args: { ownerId: string; projectId?: string | undefined }) => Promise<string[]> } {
  let started!: () => void;
  let letGo!: () => void;
  let settle!: (outcome: string[]) => void;
  const startedNow = new Promise<void>((done) => { started = done; });
  const released = new Promise<void>((done) => { letGo = done; });
  const outcome = new Promise<string[]>((done) => { settle = done; });
  return {
    started: startedNow,
    letGo,
    outcome,
    activity: async (args) => {
      started();
      await released;
      const tried = await write(args);
      settle(tried);
      return tried;
    },
  };
}

const tried = async (write: () => Promise<unknown>): Promise<string> => {
  try {
    await write();
    return 'kept';
  } catch (err) {
    return (err as Error).name;
  }
};

const fenceRaised = (kind: 'owner' | 'project', id: string) => new Promise<void>((done) => {
  const watching = db.platform.watchFences((fence) => {
    if (fence.closing.kind === kind && fence.closing.id === id) void watching.close().then(done);
  });
});

const fakeApps = { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/tmp/destroy.log', taskQueue: 'cluster-ops-queue' };

async function workers(queue: string, removal: object, removalWorkflow: string, stragglerOf: Straggler & { activity: (args: { ownerId: string; projectId?: string | undefined }) => Promise<string[]> }) {
  const namespace = env.namespace ?? 'default';
  const removing = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace, taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, removalWorkflow)), activities: removal });
  const straggling = await Worker.create({
    ...WORKER_DEFAULTS,
    interceptors: { activity: activityInterceptors() },
    connection: env.nativeConnection,
    namespace,
    taskQueue: `${queue}-straggler`,
    workflowBundle: await bundled(resolve(import.meta.dirname, 'testing/straggler.fixture-workflow.ts'), [resolve(import.meta.dirname, 'telemetry-interceptors.ts')]),
    activities: { StraggleActivity: stragglerOf.activity },
  });
  const stream = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { EngineGroveChangedActivity: async () => undefined } });
  const running = Promise.all([removing.run(), straggling.run(), stream.run()]);
  return async () => {
    removing.shutdown();
    straggling.shutdown();
    stream.shutdown();
    await running;
  };
}

const naming = () => new Client({ connection: env.connection, namespace: env.namespace ?? 'default', interceptors: { workflow: [namesItsWork] } });

describe('an account being removed while a step of its run is still writing', () => {
  it('waits for every live process to hold the account\'s fence, waits on no timer, and leaves nothing the late step tried to keep', async () => {
    const owner = `leaving-${Math.random().toString(36).slice(2, 8)}`;
    const project = `${owner}-shop`;
    await db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: at });
    await db.projects.saveProject({ id: project, name: 'shop', ownerId: owner, appType: 'gitapp', createdAt: at });
    const late = straggler(async ({ ownerId }) => [
      await tried(() => db.engine.saveConversation({ id: `${ownerId}-late`, ownerId, title: 'late', messages: [], createdAt: at, updatedAt: at } as never)),
      await tried(() => objects.put(`${ownerId}-late-file`, Readable.from([Buffer.from('late')]), 4, 'text/plain')),
    ]);
    const queue = `fenced-account-${owner}`;
    const temporal = naming();
    const removal = createAccountRemovalActivities({
      ...mock<AccountRemovalDeps>(),
      store: db,
      apps: fakeApps,
      workflows: { stopIfRunning: async (id, reason) => (await stopIfRunning(temporal.workflow.getHandle(id), reason)) !== 'not-running' },
      kube: mockFn<KubeRunner>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      secrets: { removeProject: async () => ({ workspace: false, readers: 0 }) },
      mesh: NO_MESH_HERE,
      files: { removeOwned: async () => 0 },
    });
    const stop = await workers(queue, removal, 'RemoveAccountWorkflow.ts', late);
    try {
      await temporal.workflow.start('StragglerWorkflow', { taskQueue: `${queue}-straggler`, workflowId: releaseRunWorkflowId(project), args: [{ ownerId: owner }], ...startedFor(owner) });
      await late.started;

      await db.platform.beatProcess({ id: `other-${owner}`, name: 'worker-cluster' }, new Date().toISOString());
      const raised = fenceRaised('owner', owner);
      const workflows = temporalRemovalWorkflows(() => env.client, queue);
      await workflows.start(REMOVE_ACCOUNT_WORKFLOW, removeAccountWorkflowId(owner), [{ ownerId: owner }], owner);
      await raised;
      await expect.poll(() => db.platform.fenceAcks({ kind: 'owner', id: owner })).toHaveLength(1);
      expect(await workflows.state(removeAccountWorkflowId(owner))).toEqual({ state: 'running', done: [] });
      expect(await db.accounts.getUserById(owner), 'nothing is deleted until every live process holds the fence').toBeDefined();

      await db.platform.ackFence({ kind: 'owner', id: owner }, `other-${owner}`, new Date().toISOString());
      const handle = env.client.workflow.getHandle(removeAccountWorkflowId(owner));
      expect(await handle.result()).toMatchObject({ stoppedWorkflows: 1 });
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes), 'removal waits on no timer').toBe(false);

      late.letGo();
      expect(await late.outcome).toEqual(['WorkStopped', 'WorkStopped']);
      expect(await db.accounts.accountLeftovers(owner)).toEqual({});
      expect(await objects.stat(`${owner}-late-file`)).toBeUndefined();
    } finally {
      await db.platform.forgetProcess(`other-${owner}`);
      await stop();
    }
  }, 120_000);
});

describe('a project being deleted while a step of its release is still writing', () => {
  it('refuses what the late step tries to keep for the project, and still keeps what its owner does elsewhere', async () => {
    const owner = `keeping-${Math.random().toString(36).slice(2, 8)}`;
    const project = `${owner}-shop`;
    await db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: at });
    await db.projects.saveProject({ id: project, name: 'shop', ownerId: owner, appType: 'gitapp', createdAt: at });
    const late = straggler(async ({ ownerId, projectId }) => [
      await tried(() => db.engine.saveConversation({ id: `${projectId}-late`, ownerId, projectId, title: 'late', messages: [], createdAt: at, updatedAt: at } as never)),
    ]);
    const queue = `fenced-project-${owner}`;
    const temporal = naming();
    const removal = createProjectRemovalActivities({
      ...mock<ProjectRemovalDeps>(),
      store: db,
      apps: fakeApps,
      workflows: { stopIfRunning: async (id, reason) => (await stopIfRunning(temporal.workflow.getHandle(id), reason)) !== 'not-running' },
      kube: mockFn<KubeRunner>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      repositories: { deleteRepo: async () => undefined },
      secrets: { removeProject: async () => ({ workspace: false, readers: 0 }) },
      files: { removeProjectFiles: async () => 0 },
    });
    const stop = await workers(queue, removal, 'RemoveProjectWorkflow.ts', late);
    try {
      await withWorkFor({ project }, () => temporal.workflow.start('StragglerWorkflow', { taskQueue: `${queue}-straggler`, workflowId: releaseRunWorkflowId(project), args: [{ ownerId: owner, projectId: project }], ...startedFor(owner) }));
      await late.started;

      const workflows = temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => env.client, queue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await workflows.start(REMOVE_PROJECT_WORKFLOW, removeProjectWorkflowId(project), [{ projectId: project }], owner);
      const handle = env.client.workflow.getHandle(removeProjectWorkflowId(project));
      expect(await handle.result()).toMatchObject({ stoppedWorkflows: 1 });
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes), 'deletion waits on no timer').toBe(false);

      late.letGo();
      expect(await late.outcome).toEqual(['WorkStopped']);
      await withWorkFor({ owner }, () => db.engine.saveConversation({ id: `${owner}-elsewhere`, ownerId: owner, title: 'mine', messages: [], createdAt: at, updatedAt: at } as never));
      expect((await db.projects.getProjects()).some((entry) => entry.id === project)).toBe(false);
      const conversations = await db.engine.getConversations();
      expect(conversations.some((conversation) => conversation.id === `${project}-late`)).toBe(false);
      expect(conversations.some((conversation) => conversation.id === `${owner}-elsewhere`)).toBe(true);
    } finally {
      await stop();
    }
  }, 120_000);
});
