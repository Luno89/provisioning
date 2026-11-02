import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CheckProgressArgs, CheckRunActivities } from '../../activities/CheckRunActivities.js';
import type { AccountRemovalActivities } from '../../activities/RemoveAccountActivities.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { ScenarioResult } from '../../eval/level2/results.js';
import type { CheckRunInput } from '../../workflows/CheckRunWorkflow.js';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { ownerIn } from '../../platform/lib/workflow-owner.js';
import { temporalCheckRunner } from './Level2Service.js';

const here = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const scenario = (id: string): Scenario => ({ id, name: id, describe: id, agent: 'research', procedure: { id: 'research' }, input: { message: 'go' }, expect: { outcome: 'ok' } });
const passed = (id: string): ScenarioResult => ({ scenarioId: id, name: id, runId: `run-${id}`, procedure: { id: 'research', version: '1' }, passed: true, outcome: 'ok', answer: '', checks: [], calls: [], counters: { rounds: 1, toolCalls: 0, totalTokens: 1 }, tasks: [], durationMs: 1 });
const input = (id: string): CheckRunInput => ({ checkRunId: id, person: 'bo', scenarios: [scenario('a')], tools: [] });

async function working(runScenario: CheckRunActivities['CheckRunScenarioActivity'], body: (taskQueue: string) => Promise<void>): Promise<void> {
  const taskQueue = `check-runner-test-${Math.random().toString(36).slice(2, 8)}`;
  const check: CheckRunActivities = {
    CheckCreateSpaceActivity: async ({ spaceId }) => spaceId,
    CheckRunScenarioActivity: runScenario,
    CheckSpaceGoneActivity: async () => [],
    CheckNoticedActivity: async () => [],
  };
  const removal: AccountRemovalActivities = {
    RemoveAccountWorkflowsActivity: async () => 0,
    RemoveAccountKeepRunsActivity: async () => 0,
    RemoveAccountAppsActivity: async () => [],
    RemoveAccountWorkspacesActivity: async () => '',
    RemoveAccountSecretsActivity: async () => 0,
    RemoveAccountMeshActivity: async () => ({ devices: 0, user: false }),
    RemoveAccountRepositoriesActivity: async () => false,
    RemoveAccountRecordsActivity: async () => ({}),
  };
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(here, '../../workflows/index.ts'),
    activities: { ...check, ...removal, CheckProgressActivity: async (_args: CheckProgressArgs) => undefined },
  });
  await worker.runUntil(() => body(taskQueue));
}

describe('the check runner on Temporal\'s test server', () => {
  it('starts the check run workflow on its queue, owned by the person it is for, and reads its outcome', async () => {
    await working(async ({ scenario: chosen }) => ({ result: passed(chosen.id), runIds: [`run-${chosen.id}`] }), async (taskQueue) => {
      const runner = temporalCheckRunner(() => env.client, taskQueue);
      await runner.start('check-run-r1', input('r1'));
      const description = await env.client.workflow.getHandle('check-run-r1').describe();
      expect(description.taskQueue).toBe(taskQueue);
      expect(ownerIn(description.typedSearchAttributes)).toBe('bo');
      expect(await runner.outcome('check-run-r1')).toMatchObject({ cancelled: false, results: [{ scenarioId: 'a', passed: true }] });
    });
  }, 60_000);

  it('cancels a run in flight, says there was nothing to cancel for one that is not there, and reads that it is missing', async () => {
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((done) => { entered = done; });
    await working(async () => {
      entered();
      const context = Context.current();
      while (!context.cancellationSignal.aborted) {
        context.heartbeat();
        await new Promise((tick) => setTimeout(tick, 50));
      }
      throw context.cancellationSignal.reason;
    }, async (taskQueue) => {
      const runner = temporalCheckRunner(() => env.client, taskQueue);
      await runner.start('check-run-r2', input('r2'));
      await inside;
      expect(await runner.cancel('check-run-r2')).toBe(true);
      expect(await runner.outcome('check-run-r2')).toEqual({ cancelled: true, results: [] });
      expect(await runner.cancel('check-run-never-started')).toBe(false);
      expect(await runner.outcome('check-run-never-started')).toEqual({ missing: true });
    });
  }, 60_000);

  it('refuses to start when Temporal is not there', async () => {
    await expect(temporalCheckRunner(() => undefined, 'engine-queue').start('w', input('r3'))).rejects.toThrow('Temporal is not reachable');
  });
});
