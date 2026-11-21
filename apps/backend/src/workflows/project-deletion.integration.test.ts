import { Context } from '@temporalio/activity';
import { withWorkFor } from '@koala/engine-core/work-for';
import { nodeStreams } from '@koala/engine-core/node-processes';
import { describe, expect, it } from 'vitest';
import { testClient } from '@koala/engine-core/testing/temporal';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { releaseRunWorkflowId } from '../releases/lib/release-run.js';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { uniqueName } from './testing/test-worker.js';
import { latest, type ToldDeletion } from './testing/removal-steps.js';
import { removalWorkers, removalWorld } from './testing/removal-world.js';
import type { ProjectDeleted } from './DeleteProjectWorkflow.js';

const world = removalWorld();
const at = '2026-11-21T10:00:00.000Z';

type Step = (args: { ownerId: string; projectId: string }, started: () => void) => Promise<string>;

interface DeletedWhileRunning {
  project: string;
  result: ProjectDeleted;
  told: ToldDeletion[];
  timers: boolean;
}

async function deletedWhileStepRuns(step: Step): Promise<DeletedWhileRunning> {
  const owner = uniqueName('owner');
  const project = `${owner}-shop`;
  await world.db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: at });
  await world.db.projects.saveProject({ id: project, name: 'shop', ownerId: owner, appType: 'gitapp', createdAt: at });
  let started!: () => void;
  const running = new Promise<void>((done) => { started = done; });
  const client = testClient(world.env, { interceptors: { workflow: [namesItsWork] } });
  const queue = uniqueName('deleting');
  const told: ToldDeletion[] = [];
  const { workers } = await removalWorkers(world, client, queue, { workflows: 'DeleteProjectWorkflow.ts', step: (args) => step(args, started), told });
  const runs = workers.map((worker) => worker.run());
  try {
    await withWorkFor({ project }, () => client.workflow.start('ProjectStepWorkflow', { taskQueue: `${queue}-step`, workflowId: releaseRunWorkflowId(project), args: [{ ownerId: owner, projectId: project }], ...startedFor(owner) }));
    await running;
    const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => client, queue, PROJECT_REMOVAL_PROGRESS_QUERY);
    await withWorkFor({ project, removing: 'project' }, () => workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId(project), [{ projectId: project, mode: 'permanent' }], owner));
    const handle = client.workflow.getHandle(deleteProjectWorkflowId(project));
    const result = (await handle.result()) as ProjectDeleted;
    const timers = ((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes);
    return { project, result, told, timers };
  } finally {
    for (const worker of workers) worker.shutdown();
    await Promise.all(runs);
  }
}

describe('a project being deleted while a step of its release is still writing', () => {
  it('cancels the step, waits until it has really stopped, so what it wrote on its way out is deleted with the project, and waits on no timer', async () => {
    const { project, result, told, timers } = await deletedWhileStepRuns(async ({ projectId }, started) => {
      const stop = Context.current().cancellationSignal;
      started();
      await new Promise<void>((stopped) => stop.addEventListener('abort', () => stopped(), { once: true }));
      await world.db.releases.savePipelineRunInfo({ id: `${projectId}-late`, projectId, commitSha: 'abc', ref: 'main', status: 'running', startedAt: at });
      throw stop.reason;
    });
    expect(result).toMatchObject({ stopped: [releaseRunWorkflowId(project)] });
    expect(latest(told)?.work.map((item) => [item.workflowId, item.type, item.state]), 'the person saw the step stop').toEqual([[releaseRunWorkflowId(project), 'ProjectStepWorkflow', 'stopped']]);
    expect(timers, 'deletion waits on no timer').toBe(false);
    expect((await world.db.releases.getPipelineRuns()).some((entry) => entry.projectId === project), 'what the step wrote on its way out is gone with the project').toBe(false);
    expect((await world.db.projects.getProjects()).some((entry) => entry.id === project)).toBe(false);
  });

  it('shows each program the step had started as killed once the step stopped', async () => {
    const { project, told } = await deletedWhileStepRuns(async (_args, started) => {
      const program = nodeStreams.start({ command: '/bin/sleep', args: ['600'] });
      started();
      await program.exited;
      throw new Error('its program ended');
    });
    expect(latest(told)?.work.map((item) => [item.workflowId, item.state, item.killed]), 'the person saw the step\'s program killed').toEqual([[releaseRunWorkflowId(project), 'stopped', ['sleep']]]);
  });
});
