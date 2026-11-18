import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure, Context } from '@temporalio/activity';
import { WorkflowFailedError } from '@temporalio/client';
import { activityInterceptors, WORKER_DEFAULTS, type MachineClusterOp, type MachineClusterResult } from '@koala/engine-core';
import type { ProvisionPieceKey, ProvisionTarget } from '@koala/engine-core/koala-install';
import type { ProvisionPieceRun } from '../activities/ProvisionPieceActivity.js';
import { DEFAULT_STREAM_TASK_QUEUE, deviceQueue } from '../engine-host/temporal/contracts.js';
import { provisionPieceWorkflowId } from '../infrastructure/index.js';
import { bundled, realTemporalEnvironment } from './temporal-test-env.js';
import { provisionPieceStart, type ProvisionPieceArgs } from './provision-piece.js';
import type { ProvisionPieceWorkflow } from './ProvisionPieceWorkflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORLD = `provision-piece-${randomUUID().slice(0, 8)}`;

let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await realTemporalEnvironment(); }, 120_000);
afterAll(async () => { await env?.teardown(); });

const KOALA: ProvisionTarget = { kind: 'koala', clusterId: `${WORLD}-desk` };

const piece = (key: ProvisionPieceKey, target: ProvisionTarget = KOALA, more: Partial<ProvisionPieceArgs> = {}): ProvisionPieceArgs => ({
  ownerId: 'bo', recordId: `provision-${target.clusterId}~${randomUUID().slice(0, 8)}`, target, revision: 3, piece: key, ...more,
});

async function running<T>(apply: (run: ProvisionPieceRun) => Promise<void>, drive: (taskQueue: string) => Promise<T>, machine?: { deviceId: string; seen: string[] }): Promise<T> {
  const taskQueue = `${WORLD}-${randomUUID().slice(0, 8)}`;
  const connection = env.nativeConnection;
  const namespace = env.namespace ?? 'default';
  const workers = [await Worker.create({
    ...WORKER_DEFAULTS, connection, namespace, taskQueue,
    interceptors: { activity: activityInterceptors() },
    workflowBundle: await bundled(resolve(__dirname, 'ProvisionPieceWorkflow.ts')),
    activities: { ProvisionPieceActivity: apply },
  })];
  if (machine) {
    workers.push(await Worker.create({
      ...WORKER_DEFAULTS, connection, namespace, taskQueue: deviceQueue(machine.deviceId),
      activities: { MachineClusterActivity: async (op: MachineClusterOp): Promise<MachineClusterResult> => { machine.seen.push(`machine ${op.kind}`); return op.kind === 'start' ? { state: 'running', kubeconfig: 'apiVersion: v1 # desk-2', meshIp: '100.64.0.9' } : { state: 'stopped' }; } },
    }));
    workers.push(await Worker.create({
      ...WORKER_DEFAULTS, connection, namespace, taskQueue: DEFAULT_STREAM_TASK_QUEUE,
      activities: {
        EngineMachineClusterStartedActivity: async () => { machine.seen.push('recorded started'); },
        EngineMachineClusterIdleActivity: async () => { machine.seen.push('asked idle'); return true; },
        EngineMachineClusterStoppedActivity: async () => { machine.seen.push('recorded stopped'); },
      },
    }));
  }
  const [first, ...rest] = workers;
  return rest.reduce<() => Promise<T>>((inner, worker) => () => worker.runUntil(inner), () => first!.runUntil(drive(taskQueue)))();
}

const startOne = (args: ProvisionPieceArgs, taskQueue: string) => env.client.workflow.start<typeof ProvisionPieceWorkflow>('ProvisionPieceWorkflow', provisionPieceStart(args, taskQueue));

describe('one piece of a Koala\'s setup, applied on the cluster queue', () => {
  it('applies the piece on Koala\'s own cluster and ends ok, under the id its run and piece name, owned by the Koala\'s owner', async () => {
    const applied: ProvisionPieceRun[] = [];
    const args = piece('gitea');
    const { result, id, owner } = await running(async (run) => { applied.push(run); }, async (taskQueue) => {
      const handle = await startOne(args, taskQueue);
      return { result: await handle.result(), id: handle.workflowId, owner: (await handle.describe()).typedSearchAttributes.getAll().find((pair) => pair.key.name === 'KoalaOwner')?.value };
    });
    expect(result).toEqual({ ok: true });
    expect(id).toBe(provisionPieceWorkflowId(args.recordId, 'gitea'));
    expect(owner).toBe('bo');
    expect(applied).toEqual([args]);
  }, 120_000);

  it('ends with why once the piece can never come up, rather than failing the run that follows it', async () => {
    const { result, tries } = await (async () => {
      let tries = 0;
      const result = await running(async () => { tries += 1; throw ApplicationFailure.nonRetryable('SearXNG cannot finish: pods "x" is forbidden: exceeded quota: none', 'CannotRollOut'); }, async (taskQueue) => (await startOne(piece('searxng'), taskQueue)).result());
      return { result, tries };
    })();
    expect(result).toEqual({ ok: false, why: 'SearXNG cannot finish: pods "x" is forbidden: exceeded quota: none' });
    expect(tries).toBe(1);
  }, 120_000);

  it('is one workflow for one piece of one run however many ask for it at once, applying it once and answering each', async () => {
    let applies = 0;
    let open!: () => void;
    const gate = new Promise<void>((done) => { open = done; });
    const args = piece('monitoring');
    const { results, runs } = await running(async () => { applies += 1; await gate; }, async (taskQueue) => {
      const [one, two] = await Promise.all([startOne(args, taskQueue), startOne(args, taskQueue)]);
      open();
      return { results: await Promise.all([one.result(), two.result()]), runs: new Set([one.firstExecutionRunId, two.firstExecutionRunId]) };
    });
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(runs.size).toBe(1);
    expect(applies).toBe(1);
  }, 120_000);

  it('starts another machine\'s cluster for its collector, hands the piece its kubeconfig, and lets the cluster stop once idle', async () => {
    const deviceId = `${WORLD}-desk-2`;
    const seen: string[] = [];
    const target: ProvisionTarget = { kind: 'machine', clusterId: `${WORLD}-machine-desk-2`, machine: 'desk-2' };
    const args = piece('monitoring', target, { machine: { deviceId } });
    const result = await running(async (run) => { seen.push(`applied with ${run.kubeconfig ?? 'nothing'}${'machine' in run ? ' and the machine' : ''}`); }, async (taskQueue) => (await startOne(args, taskQueue)).result(), { deviceId, seen });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(['machine start', 'recorded started', 'applied with apiVersion: v1 # desk-2', 'asked idle', 'machine stop', 'recorded stopped']);
  }, 120_000);

  it('is stopped by cancelling, handing the cancellation on rather than ending with a why', async () => {
    let started!: () => void;
    const applying = new Promise<void>((done) => { started = done; });
    const failed = await running(async () => { started(); await Context.current().cancelled; }, async (taskQueue) => {
      const handle = await startOne(piece('infisical'), taskQueue);
      await applying;
      await handle.cancel();
      return handle.result().then(() => undefined, (err: unknown) => err);
    });
    expect(failed).toBeInstanceOf(WorkflowFailedError);
    expect((failed as WorkflowFailedError).cause?.name).toBe('CancelledFailure');
  }, 120_000);
});
