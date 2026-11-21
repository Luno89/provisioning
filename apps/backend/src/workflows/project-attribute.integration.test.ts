import { describe, expect, it } from 'vitest';
import type { Client } from '@temporalio/client';
import { withWorkFor } from '@koala/engine-core/work-for';
import { testClient } from '@koala/engine-core/testing/temporal';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { PROJECT_ATTRIBUTE, projectQuery, startedFor } from '../platform/lib/workflow-owner.js';
import { until, waiting } from '../platform/testing/three-roles.js';
import { realTemporalEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from './testing/test-worker.js';
import { finishProbe } from './testing/project-probe-workflow.js';

const file = environmentForFile(() => realTemporalEnvironment());

const running = async (client: Client, project: string): Promise<string[]> => {
  const ids: string[] = [];
  for await (const execution of client.workflow.list({ query: `${projectQuery(project)} AND ExecutionStatus = "Running"` })) ids.push(execution.workflowId);
  return ids.sort();
};

const projectOf = async (client: Client, workflowId: string): Promise<string | undefined> => {
  const described = await until(`${workflowId} to have started`, async () => client.workflow.getHandle(workflowId).describe());
  const found = described.typedSearchAttributes.getAll().find((pair) => pair.key.name === PROJECT_ATTRIBUTE.name);
  return typeof found?.value === 'string' ? found.value : undefined;
};

const listedAs = (client: Client, project: string, expected: string[]) =>
  until(`${expected.join(', ')} to be listed as ${project}'s open work`, async () => {
    const ids = await running(client, project);
    return JSON.stringify(ids) === JSON.stringify([...expected].sort()) ? ids : waiting(`listed: ${ids.join(', ') || 'nothing'}`);
  });

describe('a project\'s open work, listed from Temporal by the project it names', () => {
  it('lists a workflow started for a project, the run it continued as, its child, and a child it abandoned, after the parent closed too', async () => {
    const { env } = file;
    const taskQueue = uniqueName('project-probe');
    const client = testClient(env, { interceptors: { workflow: [namesItsWork] } });
    const project = uniqueName('p');
    const worker = await testWorker(env, { taskQueue, workflows: 'testing/project-probe-workflow.ts', workflowInterceptors: ['telemetry-interceptors.ts'], activities: {} });
    const id = uniqueName('probe');
    await worker.runUntil(async () => {
      const parent = await withWorkFor({ project }, () => client.workflow.start('projectProbeWorkflow', { taskQueue, workflowId: id, args: [{ continueOnce: true }], ...startedFor('owner-1') }));
      expect(await projectOf(client, `${id}-abandoned`)).toBe(project);
      expect(await projectOf(client, `${id}-child`)).toBe(project);
      expect(await projectOf(client, id)).toBe(project);
      await listedAs(client, project, [id, `${id}-abandoned`, `${id}-child`]);
      await client.workflow.getHandle(id).signal(finishProbe);
      await parent.result().catch(() => undefined);
      await client.workflow.getHandle(id).result();
      await listedAs(client, project, [`${id}-abandoned`]);
      await client.workflow.getHandle(`${id}-abandoned`).signal(finishProbe);
      await client.workflow.getHandle(`${id}-abandoned`).result();
    });
  });

  it('lists a workflow that learns its project after it started, once it names it', async () => {
    const { env } = file;
    const taskQueue = uniqueName('project-probe');
    const client = testClient(env, { interceptors: { workflow: [namesItsWork] } });
    const project = uniqueName('late');
    const worker = await testWorker(env, { taskQueue, workflows: 'testing/project-probe-workflow.ts', workflowInterceptors: ['telemetry-interceptors.ts'], activities: {} });
    const id = uniqueName('late-probe');
    await worker.runUntil(async () => {
      await client.workflow.start('projectProbeWorkflow', { taskQueue, workflowId: id, args: [{ continueOnce: false, late: project }], ...startedFor('owner-1') });
      expect(await projectOf(client, `${id}-child`)).toBe(project);
      expect(await projectOf(client, id)).toBe(project);
      await listedAs(client, project, [id, `${id}-child`]);
      await client.workflow.getHandle(id).signal(finishProbe);
      await client.workflow.getHandle(id).result();
    });
  });
});
