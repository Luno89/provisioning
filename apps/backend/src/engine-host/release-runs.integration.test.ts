import { resolve } from 'node:path';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClusterMetadata, PipelineRunMetadata, ProjectMetadata } from '../platform/lib/types.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { releaseRunWorkflowId } from '../releases/lib/release-run.js';
import { OdooReleaseService } from '../releases/services/OdooReleaseService.js';
import { bundled, temporalTestEnvironment } from '../workflows/temporal-test-env.js';
import { engineReleaseRuns } from './release-runs.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

describe('following a project\'s release run in Temporal', () => {
  it('says it runs while it waits for the person, answers it, and follows it to its end', async () => {
    const taskQueue = `release-${Math.random().toString(36).slice(2, 8)}`;
    const projectId = `p-${taskQueue}`;
    const runs = engineReleaseRuns({
      runs: { start: async (request) => { await env.client.workflow.start('releaseStandIn', { taskQueue, workflowId: releaseRunWorkflowId(String(request.bound?.projectId)), ...startedFor(request.ownerId) }); return { runId: request.runId ?? '' } as never; } },
      client: () => env.client.workflow,
    });
    const worker = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(resolve(__dirname, 'testing/release.fixture-workflow.ts')) });

    await worker.runUntil(async () => {
      expect(await runs.running(projectId)).toBe(false);
      await runs.start({ projectId, ownerId: 'bo', agent: 'release', inputs: {} as never });
      expect(await runs.running(projectId)).toBe(true);
      const ended = runs.closed(projectId);
      await runs.answer(projectId, 'cutOver');
      await ended;
      expect(await runs.running(projectId)).toBe(false);
      expect(await env.client.workflow.getHandle(releaseRunWorkflowId(projectId)).result()).toBe('cutOver');
    });
  }, 60_000);

  it('lets the release service follow the run it started until it ends, then settles what the run never said', async () => {
    const db = await testDatabase();
    const taskQueue = `release-${Math.random().toString(36).slice(2, 8)}`;
    const project = { id: `p-${taskQueue}`, name: 'Shop', ownerId: 'bo', giteaOwner: 'bo', giteaRepo: 'shop', targetClusterId: 'c1', appType: 'gitapp', createdAt: 't' } as ProjectMetadata;
    await db.infrastructure.saveClusterInfo({ id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy', ownerId: 'bo' } as ClusterMetadata);
    await db.projects.saveProject(project);
    const runs = engineReleaseRuns({
      runs: { start: async (request) => { await env.client.workflow.start('releaseStandIn', { taskQueue, workflowId: releaseRunWorkflowId(String(request.bound?.projectId)), ...startedFor(request.ownerId) }); return { runId: request.runId ?? '' } as never; } },
      client: () => env.client.workflow,
    });
    const svc = new OdooReleaseService({ store: db, runs, chartAt: async () => true, newId: () => 'r1' });
    const worker = await Worker.create({ ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(resolve(__dirname, 'testing/release.fixture-workflow.ts')) });

    await worker.runUntil(async () => {
      await svc.release(project, { id: 'b1', projectId: project.id, commitSha: 'aaa', imageTag: 'reg/bo/shop:aaa', status: 'succeeded' } as PipelineRunMetadata);
      const following = svc.follow('bo', project.id);
      await runs.stop(project.id);
      await following;
    });
    expect((await db.releases.getOdooReleases('bo', project.id))[0]).toMatchObject({ id: 'r1', state: 'failed', reason: 'the release stopped before it said how it went' });
  }, 60_000);
});
