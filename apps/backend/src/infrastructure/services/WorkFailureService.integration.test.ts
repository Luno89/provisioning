import { activityInterceptors } from '@koala/engine-core';
import { resolve } from 'node:path';
import { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '../../platform/lib/test-database.js';
import { startedFor } from '../../platform/lib/workflow-owner.js';
import { mock } from 'vitest-mock-extended';
import { DEFAULT_STREAM_TASK_QUEUE, type WorkflowFailedReport } from '../../engine-host/temporal/contracts.js';
import { createStreamActivities, type StreamServices } from '../../engine-host/temporal/activities.js';
import { bundled, temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { WorkFailureService } from './WorkFailureService.js';
import type { UserMetadata } from '../../platform/lib/types.js';

const NOW = new Date('2026-10-17T12:00:00Z');

async function setUp() {
  const db = await testDatabase();
  await db.accounts.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: 't', twoFactorEnabled: false, emailVerified: true } as UserMetadata);
  await db.accounts.saveUser({ id: 'space-1', email: 'space-1@koala.local', createdAt: 't', twoFactorEnabled: false, emailVerified: false, space: { person: 'u1', checkRunId: 'k1', scenarioId: 's1' } } as UserMetadata);
  let now = NOW;
  const service = new WorkFailureService({
    store: db.infrastructure,
    workflows: {
      describeRun: async (runId) => ({ workflowId: runId.split('~')[0]!, type: 'AgentRunWorkflow', startedAt: NOW.toISOString(), memo: { runId } }),
    },
    records: async () => ({ trees: [{ id: 't1', name: 'Shop' }], projects: [{ id: 'p1', name: 'Books' }], conversations: [{ id: 'c1', title: 'Labels' }], checkRuns: [], releases: [], agentName: (slug) => (slug === 'koala' ? 'Koala' : undefined) }),
    accounts: db.accounts,
    now: () => now,
  });
  return { db, service, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('work that failed', () => {
  it('records a top-level run that ended failed, described the way Running describes it', async () => {
    const { service } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'grove-run-t1~5', outcome: 'failed', reason: 'the executor could not start its sandbox', depth: 0 });
    expect(await service.shown('u1')).toEqual([expect.objectContaining({
      id: 'run:grove-run-t1~5', kind: 'tree', title: 'Tree run: Shop', opens: { kind: 'tree', id: 't1' }, reason: 'the executor could not start its sandbox',
    })]);
  });

  it('leaves out child runs, runs that did not fail, and runs of a check\'s space', async () => {
    const { service } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'child', outcome: 'failed', depth: 1 });
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'interrupted', depth: 0 });
    await service.runEnded({ ownerId: 'space-1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.shown('u1')).toEqual([]);
    expect(await service.shown('space-1')).toEqual([]);
  });

  it('clears one or all, keeps a cleared one cleared, and shows only the last 7 days', async () => {
    const { service, db, later } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(60_000);
    await service.runEnded({ ownerId: 'u1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.clear('u1', ['run:run-a'])).toBe(1);
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    expect((await service.shown('u1')).map((failure) => failure.id)).toEqual(['run:run-b']);
    later(8 * 86_400_000);
    expect(await service.shown('u1')).toEqual([]);
    expect(await db.infrastructure.getWorkFailures('u1')).toHaveLength(2);
    expect(await service.clear('u1', 'all')).toBe(1);
  });

  it('forgets failures after 30 days, when it next records one', async () => {
    const { service, db, later } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(31 * 86_400_000);
    await service.runEnded({ ownerId: 'u1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect((await db.infrastructure.getWorkFailures('u1')).map((failure) => failure.id)).toEqual(['run:run-b']);
  });
});

describe('a workflow that fails tells the backend itself', () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await temporalTestEnvironment(); }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  it('is recorded before it closes, with its reason, while one that is cancelled is not', async () => {
    const { service } = await setUp();
    const namespace = env.namespace ?? 'default';
    const taskQueue = `failures-${Math.random().toString(36).slice(2, 8)}`;
    const reports: WorkflowFailedReport[] = [];
    const workflows = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue,
      workflowBundle: await bundled(resolve(__dirname, '../testing/failure.fixture-workflow.ts'), [resolve(__dirname, '../../workflows/failure-reports.ts')]),
    });
    const stream = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: { EngineWorkflowFailedActivity: createStreamActivities({ ...mock<StreamServices>(), workflowFailed: async (report) => { reports.push(report); await service.workflowFailed(report); } }).EngineWorkflowFailedActivity },
    });

    await stream.runUntil(workflows.runUntil(async () => {
      const failing = await env.client.workflow.start('RemoveProjectWorkflow', { taskQueue, workflowId: `remove-project-p1-${taskQueue}`, ...startedFor('u1') });
      await expect(failing.result()).rejects.toThrow();
      expect(await service.shown('u1')).toEqual([expect.objectContaining({
        id: `workflow:remove-project-p1-${taskQueue}:${failing.firstExecutionRunId}`, kind: 'removal', reason: 'the project\'s cluster could not be reached',
      })]);

      const cancelled = await env.client.workflow.start('waitsToBeCancelled', { taskQueue, workflowId: `cancelled-${taskQueue}`, ...startedFor('u1') });
      await cancelled.cancel();
      await expect(cancelled.result()).rejects.toThrow();
    }));

    expect(reports.map((report) => report.type)).toEqual(['RemoveProjectWorkflow']);
  }, 60_000);
});
