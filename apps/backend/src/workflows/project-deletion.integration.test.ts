import { Context } from '@temporalio/activity';
import type { Client, WorkflowHandle } from '@temporalio/client';
import { withWorkFor } from '@koala/engine-core/work-for';
import { nodeStreams } from '@koala/engine-core/node-processes';
import { resolve } from 'node:path';
import { childEnv } from '@koala/engine-core/child-env';
import { startKept } from '@koala/engine-core/testing/kept';
import { describe, expect, inject, it } from 'vitest';
import { stopWorkOf } from '@koala/engine-core';
import { deviceQueue } from '../engine-host/temporal/contracts.js';
import { bundled } from './testing/temporal-test-env.js';
import { MACHINE_STEP_ASKED_TO_STOP, MACHINE_STEP_STARTED } from './testing/machine-step.fixture-workflow.js';
import { testClient } from '@koala/engine-core/testing/temporal';
import { temporalRemovalWorkflows } from '../accounts/services/AccountRemovalService.js';
import { DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId, PROJECT_REMOVAL_PROGRESS_QUERY, type ProjectRemovalStep } from '../projects/lib/project-removal.js';
import { releaseRunWorkflowId } from '../releases/lib/release-run.js';
import { namesItsWork } from '../platform/lib/temporal-client.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { testWorker, uniqueName } from './testing/test-worker.js';
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

  it('shows work on a machine that went off as stopping when the machine wakes, leaves the stop to Temporal until the machine polls again, and shows it stopped once the machine answers', async () => {
    await whileItsMachineIsOff(async ({ project, deviceId, handle, told }) => {
      const asked: string[][] = [];
      const back = await testWorker(world.env, { taskQueue: deviceQueue(deviceId), activities: { StopMachineWorkActivity: async ({ workflowIds }: { workflowIds: string[] }) => { asked.push(workflowIds); return { killed: await stopWorkOf(workflowIds, 'the project is being deleted') }; } } });
      await back.runUntil(handle.result());
      const timers = ((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes);
      expect(asked, 'the machine, once back, was asked to stop that work').toEqual([[`${project}-on-desk`]]);
      expect(latest(told)?.work.map((item) => [item.workflowId, item.state, item.killed]), 'nothing of it ran after the machine restarted').toEqual([[`${project}-on-desk`, 'stopped', undefined]]);
      expect(latest(told)?.phase).toBe('deleted');
      expect(timers, 'deletion waits on no timer').toBe(false);
    });
  });

  it('ends the wait for a machine that is off the moment the machine is removed, shows it removed, and deletes the project with no timer', async () => {
    await whileItsMachineIsOff(async ({ project, deviceId, handle, told, client }) => {
      await world.db.machines.deleteLocalAgentDevice(deviceId);
      const result = await Promise.race([handle.result() as Promise<ProjectDeleted>, neverEndingWhileOff(client, deleteProjectWorkflowId(project), 'Desk')]);
      const timers = ((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes);
      expect(result).toMatchObject({ stopped: [`${project}-on-desk`] });
      expect(latest(told)?.work.map((item) => [item.workflowId, item.state, item.machine]), 'the person sees the machine was removed, never stopped').toEqual([[`${project}-on-desk`, 'machine-removed', 'Desk']]);
      expect(latest(told)?.phase).toBe('deleted');
      expect(timers, 'deletion waits on no timer').toBe(false);
    });
  });

  it('ends a deletion cancelled while it waits for a machine that is off as cancelled, with no timer', async () => {
    await whileItsMachineIsOff(async ({ project, handle, client }) => {
      await handle.cancel();
      const ended = await Promise.race([handle.result().then(() => 'completed', () => 'rejected'), neverEndingWhileOff(client, deleteProjectWorkflowId(project), 'Desk')]);
      const timers = ((await handle.fetchHistory()).events ?? []).some((event) => event.timerStartedEventAttributes);
      const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => client, 'unused', PROJECT_REMOVAL_PROGRESS_QUERY);
      expect(ended).toBe('rejected');
      expect((await handle.describe()).status.name, 'the deletion ended as what happened to it').toBe('CANCELLED');
      const state = await workflows.state(deleteProjectWorkflowId(project));
      expect(state.state).toBe('failed');
      expect(state.state === 'failed' ? state.reason : '', 'the person reads why it ended, never the codec refusing Temporal\'s own words').not.toMatch(/unencrypted/);
      expect(timers, 'deletion waits on no timer').toBe(false);
    });
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

interface MachineOff {
  project: string;
  deviceId: string;
  client: Client;
  handle: WorkflowHandle;
  told: ToldDeletion[];
}

async function neverEndingWhileOff(client: Client, workflowId: string, machine: string): Promise<never> {
  const open = new Map<string, string>();
  const scheduled = new Set<string>();
  let nextPageToken: Uint8Array | undefined;
  for (;;) {
    const page = await client.workflowService.getWorkflowExecutionHistory({ namespace: client.options.namespace, execution: { workflowId }, waitNewEvent: true, ...(nextPageToken ? { nextPageToken } : {}) });
    for (const event of page.history?.events ?? []) {
      const activity = event.activityTaskScheduledEventAttributes?.activityType?.name;
      if (activity) { open.set(String(event.eventId), activity); scheduled.add(activity); }
      const closed = event.activityTaskCompletedEventAttributes ?? event.activityTaskFailedEventAttributes ?? event.activityTaskCanceledEventAttributes ?? event.activityTaskTimedOutEventAttributes;
      if (closed) open.delete(String(closed.scheduledEventId));
      const failed = event.workflowTaskFailedEventAttributes;
      if (failed) throw new Error(`the deletion cannot go on, its workflow task failed: ${failed.failure?.message ?? 'Temporal gave no reason'}`);
    }
    if (new Set(open.values()).has('StopMachineWorkActivity') && !scheduled.has('AwaitMachineRemovedActivity')) {
      throw new Error(`the deletion waits on ${machine}'s own queue, which nothing will poll again now ${machine} is removed, and nothing of it hears the removal, so it can never end`);
    }
    if (!page.nextPageToken || page.nextPageToken.length === 0) return new Promise<never>(() => undefined);
    nextPageToken = page.nextPageToken;
  }
}

async function whileItsMachineIsOff(then: (off: MachineOff) => Promise<void>): Promise<void> {
  const owner = uniqueName('owner');
  const project = `${owner}-shop`;
  const deviceId = uniqueName('desk');
  await world.db.accounts.saveUser({ id: owner, email: `${owner}@example.com`, twoFactorEnabled: false, emailVerified: true, createdAt: at });
  await world.db.projects.saveProject({ id: project, name: 'shop', ownerId: owner, appType: 'gitapp', createdAt: at });
  await world.db.machines.saveLocalAgentDevice({ id: deviceId, ownerId: owner, name: 'Desk', rootDir: '/home/person/koala', createdAt: at, tokenHash: 'hash' });
  const client = testClient(world.env, { interceptors: { workflow: [namesItsWork] } });
  const queue = uniqueName('deleting');
  const told: ToldDeletion[] = [];
  let sawWaiting!: () => void;
  const waiting = new Promise<void>((done) => { sawWaiting = done; });
  const push = told.push.bind(told);
  told.push = (...changes: ToldDeletion[]) => {
    if (changes.some((change) => change.progress.work.some((item) => item.state === 'waiting-machine'))) sawWaiting();
    return push(...changes);
  };
  const { workers } = await removalWorkers(world, client, queue, { workflows: 'DeleteProjectWorkflow.ts', step: async () => 'unused', told });
  const machineSteps = await testWorker(world.env, { taskQueue: `${queue}-machine`, workflowBundle: await bundled(resolve(import.meta.dirname, 'testing', 'machine-step.fixture-workflow.ts'), [resolve(import.meta.dirname, 'telemetry-interceptors.ts')]), activities: {} });
  const runs = [...workers, machineSteps].map((worker) => worker.run());
  const hears = new Map<string, () => void>();
  const hearing = (line: string) => new Promise<void>((done) => { hears.set(line, done); });
  const started = hearing(MACHINE_STEP_STARTED);
  const askedToStop = hearing(MACHINE_STEP_ASKED_TO_STOP);
  const machine = startKept({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), resolve(import.meta.dirname, 'testing', 'machine-worker.fixture-program.ts'), JSON.stringify({ address: inject('temporalAddress'), namespace: world.env.namespace, taskQueue: deviceQueue(deviceId), ring: world.env.payloads.ring })],
    env: childEnv(),
  }, {
    heard: { stdout: (chunk) => { for (const line of chunk.split('\n')) hears.get(line)?.(); } },
  });
  const beforeTheMachineEnds = <T>(wait: Promise<T>): Promise<T> => Promise.race([wait, machine.ended.then((ended) => { throw new Error(`the machine's program ended first: ${ended.stderr.trim() || `exit ${ended.code}`}`); })]);
  const handle = client.workflow.getHandle(deleteProjectWorkflowId(project));
  try {
    await withWorkFor({ project }, () => client.workflow.start('MachineStepWorkflow', { taskQueue: `${queue}-machine`, workflowId: `${project}-on-desk`, args: [{ projectId: project, deviceId }], ...startedFor(owner) }));
    await beforeTheMachineEnds(started);
    const workflows = temporalRemovalWorkflows<{ projectId: string; mode: 'archive' | 'permanent' }, ProjectRemovalStep>(() => client, queue, PROJECT_REMOVAL_PROGRESS_QUERY);
    await withWorkFor({ project, removing: 'project' }, () => workflows.start(DELETE_PROJECT_WORKFLOW, deleteProjectWorkflowId(project), [{ projectId: project, mode: 'permanent' }], owner));
    await beforeTheMachineEnds(askedToStop);
    machine.stop('SIGKILL');
    expect(await machine.exited).toMatchObject({ signal: 'SIGKILL' });
    await Promise.race([waiting, handle.result().then(() => { throw new Error('the deletion ended without waiting for the machine'); })]);
    expect(latest(told)?.work.map((item) => [item.workflowId, item.state, item.machine]), 'the person sees it will stop when the machine wakes').toEqual([[`${project}-on-desk`, 'waiting-machine', 'Desk']]);
    await then({ project, deviceId, client, handle, told });
  } finally {
    machine.stop('SIGKILL');
    for (const worker of [...workers, machineSteps]) worker.shutdown();
    await Promise.all(runs);
  }
}
