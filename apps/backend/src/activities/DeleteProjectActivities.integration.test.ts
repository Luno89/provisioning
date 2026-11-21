import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { withWorkFor } from '@koala/engine-core/work-for';
import { testClient } from '@koala/engine-core/testing/temporal';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { until, waiting } from '../platform/testing/three-roles.js';
import { realTemporalEnvironment } from '../workflows/testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from '../workflows/testing/test-worker.js';
import { createFrozenWorkActivities, createProjectDeletionActivities, temporalProjectWork, type ProjectRemovalSteps } from './DeleteProjectActivities.js';

const file = environmentForFile(() => realTemporalEnvironment());

describe('stopping a project\'s work, found in Temporal by the project it names', () => {
  it('cancels every open run of the project and its child, leaves another project\'s alone, and waits until Temporal closes them', async () => {
    const { env } = file;
    const client = testClient(env, { interceptors: { workflow: [namesItsWork] } });
    const taskQueue = uniqueName('deletion-stop');
    const project = uniqueName('going');
    const other = uniqueName('staying');
    const worker = await testWorker(env, { taskQueue, workflows: 'testing/project-probe-workflow.ts', workflowInterceptors: ['telemetry-interceptors.ts'], activities: {} });
    const restarts: string[] = [];
    const deletion = createProjectDeletionActivities({ work: temporalProjectWork(async () => client), removal: mock<ProjectRemovalSteps>() });
    const frozen = createFrozenWorkActivities({ work: temporalProjectWork(async () => client), workers: { restart: async (identity) => { restarts.push(identity); return 'restarted'; } } });
    const going = uniqueName('run');
    const staying = uniqueName('run');
    await worker.runUntil(async () => {
      await withWorkFor({ project }, () => client.workflow.start('projectProbeWorkflow', { taskQueue, workflowId: going, args: [{ continueOnce: false }], ...startedFor('owner-1') }));
      await withWorkFor({ project: other }, () => client.workflow.start('projectProbeWorkflow', { taskQueue, workflowId: staying, args: [{ continueOnce: false }], ...startedFor('owner-1') }));
      await until('the project\'s run and its child to be listed', async () => {
        const ids: string[] = [];
        for await (const found of client.workflow.list({ query: `KoalaProject = "${project}" AND ExecutionStatus = "Running"` })) ids.push(found.workflowId);
        return ids.length === 2 ? ids : waiting(`listed: ${ids.join(', ') || 'nothing'}`);
      });
      const stopped = await deletion.StopProjectWorkActivity({ projectId: project });
      expect([...stopped].sort()).toEqual([going, `${going}-child`].sort());
      expect(await frozen.AwaitProjectWorkActivity({ workflowIds: stopped })).toEqual({ restarted: [] });
      expect((await client.workflow.getHandle(going).describe()).status.name).toBe('CANCELLED');
      expect((await client.workflow.getHandle(staying).describe()).status.name).toBe('RUNNING');
      await client.workflow.getHandle(staying).cancel();
    });
    expect(restarts).toEqual([]);
  });
});
