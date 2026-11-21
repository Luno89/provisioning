import { describe, expect, it } from 'vitest';
import { testClient } from '@koala/engine-core/testing/temporal';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { deleteProjectWorkflowId } from '../projects/lib/project-removal.js';
import { ARCHIVE_DAYS, PURGE_PROJECT_WORKFLOW, keptUntil, purgeProjectWorkflowId, purgeStart } from '../projects/lib/project-archive.js';
import { temporalPurges } from '../projects/services/ProjectRemovalService.js';
import { realTemporalEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from './testing/test-worker.js';

const file = environmentForFile(() => realTemporalEnvironment());

const DAY_MS = 86_400_000;

describe('an archived project, kept by Temporal for its 90 days', () => {
  it('is kept until a date Temporal itself holds: the purge starts 90 days after it was asked to, and nothing of it runs before', async () => {
    const { env } = file;
    const client = testClient(env);
    const project = uniqueName('archived');
    const handle = await client.workflow.start(PURGE_PROJECT_WORKFLOW, { ...purgeStart(project, 'atq-unpolled'), ...startedFor('owner-1') });
    const described = await handle.describe();
    expect(described.status.name).toBe('RUNNING');
    expect(described.executionTime!.getTime() - described.startTime.getTime()).toBe(ARCHIVE_DAYS * DAY_MS);
    expect(keptUntil(described)).toEqual(described.executionTime);
    expect(await temporalPurges(async () => client, 'atq-unpolled').keptUntil(project), 'the date the page shows is the one Temporal holds').toEqual(described.executionTime);
    expect(await temporalPurges(async () => client, 'atq-unpolled').keptUntil(uniqueName('never-deleted'))).toBeUndefined();
    expect(described.historyLength).toBe(1);
    await handle.cancel();
  });

  it('wakes at once and deletes for good when asked to delete now, through the one deletion', async () => {
    const { env } = file;
    const client = testClient(env);
    const taskQueue = uniqueName('purge');
    const project = uniqueName('archived');
    const deleted: string[] = [];
    const worker = await testWorker(env, {
      taskQueue,
      workflows: 'testing/purge-probe-workflows.ts',
      activities: {},
    });
    await worker.runUntil(async () => {
      await client.workflow.start(PURGE_PROJECT_WORKFLOW, { ...purgeStart(project, taskQueue), ...startedFor('owner-1') });
      await temporalPurges(async () => client, taskQueue).now(project, 'owner-1');
      deleted.push(...((await client.workflow.getHandle(purgeProjectWorkflowId(project)).result()) as { purged: string[] }).purged);
      expect(await client.workflow.getHandle(deleteProjectWorkflowId(project)).result(), 'the purge is the one deletion, run for good').toEqual({ deleted: project, mode: 'permanent' });
    });
    expect(deleted).toEqual([project]);
  });

  it('wakes at once and ends without deleting anything when the project is restored', async () => {
    const { env } = file;
    const client = testClient(env);
    const taskQueue = uniqueName('purge');
    const project = uniqueName('archived');
    const worker = await testWorker(env, { taskQueue, workflows: 'testing/purge-probe-workflows.ts', activities: {} });
    await worker.runUntil(async () => {
      await client.workflow.start(PURGE_PROJECT_WORKFLOW, { ...purgeStart(project, taskQueue), ...startedFor('owner-1') });
      await temporalPurges(async () => client, taskQueue).restore(project, 'owner-1');
      expect(await client.workflow.getHandle(purgeProjectWorkflowId(project)).result()).toEqual({ purged: [] });
    });
  });
});
