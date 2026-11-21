import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { withWorkFor } from '@koala/engine-core/work-for';
import { testClient } from '@koala/engine-core/testing/temporal';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { until, waiting } from '../platform/testing/three-roles.js';
import { testDatabase } from '../platform/lib/test-database.js';
import { ARCHIVE_DAYS, purgeProjectWorkflowId } from '../projects/lib/project-archive.js';
import { realTemporalEnvironment } from '../workflows/testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from '../workflows/testing/test-worker.js';
import { createFrozenWorkActivities, createProjectDeletionActivities, temporalProjectWork, temporalProjectArchive, type ProjectArchive, type ProjectRemovalSteps } from './DeleteProjectActivities.js';

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
    const deletion = createProjectDeletionActivities({ work: temporalProjectWork(async () => client), removal: mock<ProjectRemovalSteps>(), archive: mock<ProjectArchive>() });
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
      expect(stopped.map((work) => work.workflowId).sort()).toEqual([going, `${going}-child`].sort());
      expect(new Set(stopped.map((work) => work.type)), 'each is listed with its type, which names it for the person').toEqual(new Set(['projectProbeWorkflow', 'projectProbeChildWorkflow']));
      for (const work of stopped) expect(await frozen.AwaitProjectWorkActivity({ workflowId: work.workflowId })).toEqual({ frozen: [] });
      expect((await client.workflow.getHandle(going).describe()).status.name).toBe('CANCELLED');
      expect((await client.workflow.getHandle(staying).describe()).status.name).toBe('RUNNING');
      await client.workflow.getHandle(staying).cancel();
    });
    expect(restarts).toEqual([]);
  });
});

describe('keeping a deleted project for its 90 days', () => {
  it('archives it and leaves Temporal one purge of it, due 90 days on, however often it is asked', async () => {
    const { env } = file;
    const client = testClient(env, { interceptors: { workflow: [namesItsWork] } });
    const db = await testDatabase();
    const project = uniqueName('kept');
    await db.projects.saveProject({ id: project, name: 'kept', ownerId: 'owner-1', appType: 'gitapp', createdAt: '2026-11-21T00:00:00.000Z' });
    await db.projects.markDeleting(project, { startedAt: '2026-11-21T00:00:00.000Z', requestedBy: 'owner-1', mode: 'archive' });
    const deletion = createProjectDeletionActivities({ work: temporalProjectWork(async () => client), removal: mock<ProjectRemovalSteps>(), archive: temporalProjectArchive(async () => client, db.projects, uniqueName('purges')) });
    const first = await deletion.ArchiveProjectActivity({ projectId: project });
    const again = await deletion.ArchiveProjectActivity({ projectId: project });
    expect(await db.projects.deletion(project)).toMatchObject({ phase: 'archived' });
    const described = await client.workflow.getHandle(purgeProjectWorkflowId(project)).describe();
    expect(first, 'the date shown is the one Temporal will purge it on').toEqual({ keptUntil: described.executionTime!.toISOString() });
    expect(again).toEqual(first);
    expect(described.status.name).toBe('RUNNING');
    expect(described.executionTime!.getTime() - described.startTime.getTime()).toBe(ARCHIVE_DAYS * 86_400_000);
    expect(described.typedSearchAttributes.getAll().map((pair) => pair.key.name), 'the purge is the deletion\'s own work, not the project\'s').not.toContain('KoalaProject');
    await client.workflow.getHandle(purgeProjectWorkflowId(project)).cancel();
  });
});
