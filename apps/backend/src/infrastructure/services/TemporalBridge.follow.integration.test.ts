import { resolve } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { ClusterMetadata, DeploymentMetadata, ProjectMetadata } from '../../platform/index.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { TemporalBridge } from './TemporalBridge.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

describe('following work Koala started anywhere to its end', () => {
  it('settles each app another process deploys when its workflow ends, from the record alone, and takes a workflow Temporal never had as failed', async () => {
    const db = await testDatabase();
    const namespace = env.namespace ?? 'default';
    const connection = await Connection.connect({ address: inject('temporalAddress') });
    const bridge = new TemporalBridge(db);
    bridge.client = new Client({ connection, namespace });
    const followings: Promise<void>[] = [];
    let allFollowed!: () => void;
    const threeFollowed = new Promise<void>((done) => { allFollowed = done; });
    const follow = bridge.follow.bind(bridge);
    vi.spyOn(bridge, 'follow').mockImplementation((...args) => {
      const following = follow(...args);
      followings.push(following);
      if (followings.length === 3) allFollowed();
      return following;
    });
    const taskQueue = `follow-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue, workflowBundle: await bundled(resolve(__dirname, '../testing/follow.fixture-workflow.ts')) });
    const app = (id: string, extra: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id, name: id, clusterId: 'c1', strategy: 'helm', status: 'deploying', ownerId: 'u1', temporalWorkflowId: '', ...extra });

    await worker.runUntil(async () => {
      await bridge.followWork();
      for (const [id, outcome] of [['shop', 'healthy'], ['blog', 'fails']] as const) {
        await db.infrastructure.saveDeployment(app(id));
        const workflowId = `deploy-${id}-${taskQueue}`;
        await env.client.workflow.start('deploys', { taskQueue, workflowId, args: [outcome] });
        await db.infrastructure.saveDeploymentInfo({ id, temporalWorkflowId: workflowId });
      }
      await db.infrastructure.saveDeployment(app('wiki', { temporalWorkflowId: `never-started-${taskQueue}` }));
      await threeFollowed;
      await Promise.all(followings);
    });
    await bridge.stop();

    const statuses = Object.fromEntries((await db.infrastructure.getDeployments()).map((dep) => [dep.id, dep.status]));
    expect(statuses).toEqual({ shop: 'running', blog: 'failed', wiki: 'failed' });
  }, 60_000);
});

describe('cancelling and reading work in Temporal', () => {
  it('cancels a workflow that runs, says one that finished or never ran is not running, and reads a workflow\'s history', async () => {
    const namespace = env.namespace ?? 'default';
    const connection = await Connection.connect({ address: inject('temporalAddress') });
    const bridge = new TemporalBridge(await testDatabase());
    bridge.client = new Client({ connection, namespace });
    const taskQueue = `cancel-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue, workflowBundle: await bundled(resolve(__dirname, '../testing/follow.fixture-workflow.ts')) });

    await worker.runUntil(async () => {
      const done = await env.client.workflow.start('deploys', { taskQueue, workflowId: `done-${taskQueue}`, args: ['healthy'] });
      await done.result();
      const waiting = await env.client.workflow.start('waitsToBeCancelled', { taskQueue, workflowId: `waiting-${taskQueue}` });

      expect(await bridge.cancelWorkflow(waiting.workflowId)).toBe('cancelled');
      await expect(waiting.result()).rejects.toThrow();
      expect(await bridge.cancelWorkflow(done.workflowId)).toBe('not-running');
      expect(await bridge.cancelWorkflow(`never-started-${taskQueue}`)).toBe('not-running');

      const history = await bridge.getWorkflowHistory(done.workflowId) as { type: unknown }[];
      const { EventType } = temporal.api.enums.v1;
      expect([history[0]?.type, history.at(-1)?.type]).toEqual([EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED, EventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED]);
      expect(await bridge.getWorkflowHistory(`never-started-${taskQueue}`)).toBeNull();
      expect(await bridge.describeWorkflow(`never-started-${taskQueue}`)).toBeNull();
    });
  }, 60_000);
});

describe('settling the work the bridge itself starts', () => {
  it('destroys a cluster and an app, resizes and syncs an app, and records a build, each settled from its workflow\'s end', async () => {
    const db = await testDatabase();
    const namespace = env.namespace ?? 'default';
    const connection = await Connection.connect({ address: inject('temporalAddress') });
    const bridge = new TemporalBridge(db);
    bridge.client = new Client({ connection, namespace });
    const decided: string[] = [];
    bridge.decideRelease = async (project, since, commit) => { decided.push(`${project.id} ${since} ${commit}`); return { release: false, reason: 'nothing the app is built from changed' }; };
    const followings: Promise<void>[] = [];
    const follow = bridge.follow.bind(bridge);
    vi.spyOn(bridge, 'follow').mockImplementation((...args) => { const following = follow(...args); followings.push(following); return following; });
    const app = (id: string, extra: Partial<DeploymentMetadata> = {}): DeploymentMetadata => ({ id, name: id, clusterId: 'c1', strategy: 'helm', status: 'running', ownerId: 'u1', temporalWorkflowId: 'done', ...extra });

    await db.infrastructure.saveClusterInfo({ id: 'c1', name: 'spare', provider: 'k3d', status: 'healthy', ownerId: 'u1' } as ClusterMetadata);
    await db.infrastructure.saveClusterInfo({ id: 'c2', name: 'old', provider: 'k3d', status: 'healthy', ownerId: 'u1' } as ClusterMetadata);
    for (const id of ['gone', 'grown', 'synced']) await db.infrastructure.saveDeployment(app(id));
    const project = { id: 'p1', name: 'Shop', ownerId: 'u1', giteaOwner: 'bo', giteaRepo: 'shop', autoDeployOnBuild: true, createdAt: 't' } as ProjectMetadata;
    await db.projects.saveProject(project);
    await db.infrastructure.saveDeployment(app('shop', { appType: 'gitapp', gitappProjectId: 'p1', gitappImageTag: 'reg/bo/shop:aaa' }));

    const bundle = await bundled(resolve(__dirname, '../testing/bridge.fixture-workflow.ts'));
    const workers = await Promise.all(['host-ops-queue', 'cluster-ops-queue'].map((taskQueue) => Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue, workflowBundle: bundle })));
    await workers[0]!.runUntil(workers[1]!.runUntil(async () => {
      await bridge.destroyCluster('c2');
      await bridge.destroyApp('gone');
      await bridge.resizeDisk('grown', { data: '20Gi' });
      await bridge.syncConfig('synced');
      const build = await bridge.runPipeline(project, 'b'.repeat(40), 'refs/heads/main');
      expect(build).toMatchObject({ event: 'pipeline-run' });
      await Promise.all(followings);
    }));
    await bridge.stop();
    await connection.close();

    expect((await db.infrastructure.getClusters()).map((cluster) => cluster.id)).toEqual(['c1']);
    const deployments = new Map((await db.infrastructure.getDeployments()).map((dep) => [dep.id, dep]));
    expect(deployments.has('gone')).toBe(false);
    expect(deployments.get('grown')).toMatchObject({ status: 'running', storage: { data: '20Gi' } });
    expect(deployments.get('synced')).toMatchObject({ status: 'unhealthy', healthReason: 'its pod cannot pull its image' });
    const [run] = await db.releases.getPipelineRuns();
    expect(run).toMatchObject({ projectId: 'p1', status: 'succeeded', imageTag: 'reg/bo/shop:bbb', releaseSkipped: 'nothing the app is built from changed' });
    expect(decided).toEqual([`p1 aaa ${'b'.repeat(40)}`]);
  }, 60_000);
});

