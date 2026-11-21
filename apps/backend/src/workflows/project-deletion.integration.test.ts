import { Context } from '@temporalio/activity';
import { withWorkFor } from '@koala/engine-core/work-for';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mock, mockFn } from 'vitest-mock-extended';
import { testClient, type TestTemporal } from '@koala/engine-core/testing/temporal';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { createFrozenWorkActivities, createProjectDeletionActivities, temporalProjectWork } from '../activities/DeleteProjectActivities.js';
import { createProjectRemovalActivities, type ProjectRemovalDeps } from '../activities/RemoveProjectActivities.js';
import type { KubeRunner } from '../engine-host/sandboxes/kube.js';
import { DEFAULT_STREAM_TASK_QUEUE } from '../engine-host/temporal/contracts.js';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { releaseRunWorkflowId } from '../releases/lib/release-run.js';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { QUEUES } from '../platform/lib/work-places.js';
import type { MongoDB } from '../platform/lib/mongo-db.js';
import { bundled, realTemporalEnvironment } from './testing/temporal-test-env.js';
import { testWorker, uniqueName } from './testing/test-worker.js';

let env: TestTemporal;
let db: MongoDB;
const at = '2026-11-21T10:00:00.000Z';

beforeAll(async () => {
  env = await realTemporalEnvironment();
  db = await testDatabase();
});

afterAll(async () => {
  await env?.teardown();
});

const fakeApps = { clusterById: async () => undefined, handOver: async (clusterId: string) => ({ clusterId, reach: { clusterId, kind: 'koala' as const } }), logFile: () => '/tmp/destroy.log', taskQueue: QUEUES.cluster };

describe('a project being deleted while a step of its release is still writing', () => {
  it('cancels the step, waits until it has really stopped, so what it wrote on its way out is deleted with the project, and waits on no timer', async () => {
    const owner = uniqueName('owner');
    const project = `${owner}-shop`;
    await db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: at });
    await db.projects.saveProject({ id: project, name: 'shop', ownerId: owner, appType: 'gitapp', createdAt: at });
    let started!: () => void;
    const running = new Promise<void>((done) => { started = done; });
    const step = async ({ projectId }: { ownerId: string; projectId: string }): Promise<string> => {
      const stop = Context.current().cancellationSignal;
      started();
      await new Promise<void>((stopped) => stop.addEventListener('abort', () => stopped(), { once: true }));
      await db.releases.savePipelineRunInfo({ id: `${projectId}-late`, projectId, commitSha: 'abc', ref: 'main', status: 'running', startedAt: at });
      throw stop.reason;
    };
    const client = testClient(env, { interceptors: { workflow: [namesItsWork] } });
    const queue = uniqueName('deleting');
    const removal = createProjectRemovalActivities({
      ...mock<ProjectRemovalDeps>(),
      store: db,
      apps: fakeApps,
      kube: mockFn<KubeRunner>().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
      repositories: { deleteRepo: async () => undefined },
      secrets: { removeProject: async () => ({ workspace: false, readers: 0 }) },
      files: { removeProjectFiles: async () => 0 },
    });
    const work = temporalProjectWork(async () => client);
    const workers = await Promise.all([
      testWorker(env, { taskQueue: queue, workflowBundle: await bundled(resolve(import.meta.dirname, 'DeleteProjectWorkflow.ts')), activities: createProjectDeletionActivities({ work, removal }) }),
      testWorker(env, { taskQueue: QUEUES.cluster, activities: createFrozenWorkActivities({ work, workers: { restart: async () => 'not-here' } }) }),
      testWorker(env, { taskQueue: `${queue}-step`, workflowBundle: await bundled(resolve(import.meta.dirname, 'testing/project-step.fixture-workflow.ts'), [resolve(import.meta.dirname, 'telemetry-interceptors.ts')]), activities: { ProjectStepActivity: step } }),
      testWorker(env, { taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: { EngineGroveChangedActivity: async () => undefined } }),
    ]);
    const runs = workers.map((worker) => worker.run());
    try {
      await withWorkFor({ project }, () => client.workflow.start('ProjectStepWorkflow', { taskQueue: `${queue}-step`, workflowId: releaseRunWorkflowId(project), args: [{ ownerId: owner, projectId: project }], ...startedFor(owner) }));
      await running;
      const workflows = temporalRemovalWorkflows<{ projectId: string }, ProjectRemovalStep>(() => client, queue, PROJECT_REMOVAL_PROGRESS_QUERY);
      await withWorkFor({ project, removing: 'project' }, () => workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId(project), [{ projectId: project }], owner));
      const handle = client.workflow.getHandle(deleteProjectWorkflowId(project));
      expect(await handle.result()).toMatchObject({ stopped: [releaseRunWorkflowId(project)] });
      expect(((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes), 'deletion waits on no timer').toBe(false);
      expect((await db.releases.getPipelineRuns()).some((entry) => entry.projectId === project), 'what the step wrote on its way out is gone with the project').toBe(false);
      expect((await db.projects.getProjects()).some((entry) => entry.id === project)).toBe(false);
    } finally {
      for (const worker of workers) worker.shutdown();
      await Promise.all(runs);
    }
  });
});
