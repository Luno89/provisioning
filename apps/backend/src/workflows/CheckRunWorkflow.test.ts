import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { CheckProgressArgs, CheckRunActivities } from '../activities/CheckRunActivities.js';
import type { AccountRemovalActivities } from '../activities/RemoveAccountActivities.js';
import type { Scenario } from '../eval/level2/scenario.js';
import type { ScenarioResult } from '../eval/level2/results.js';
import type { CheckRunOutcome } from './CheckRunWorkflow.js';
import { ownerIn, startedFor } from '../lib/workflow-owner.js';
import { removeAccountWorkflowId } from '../lib/account-removal.js';
import { temporalTestEnvironment } from './temporal-test-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const scenario = (id: string): Scenario => ({ id, name: id, describe: id, agent: 'research', procedure: { id: 'research' }, input: { message: 'go' }, expect: { outcome: 'ok' } });
const passed = (id: string): ScenarioResult => ({ scenarioId: id, name: id, runId: `run-${id}`, procedure: { id: 'research', version: '1' }, passed: true, outcome: 'ok', answer: '', checks: [], calls: [], counters: { rounds: 1, toolCalls: 0, totalTokens: 1 }, tasks: [], durationMs: 1 });

function harness(runScenario: CheckRunActivities['CheckRunScenarioActivity'], leaks: ReadonlySet<string> = new Set()) {
  const log: string[] = [];
  const progress: CheckProgressArgs[] = [];
  const check: CheckRunActivities = {
    CheckCreateSpaceActivity: async ({ spaceId, scenario: chosen }) => { log.push(`space ${chosen.id}`); return spaceId; },
    CheckRunScenarioActivity: runScenario,
    CheckSpaceGoneActivity: async ({ spaceId }) => { log.push('gone?'); return leaks.has(spaceId) ? ['1 in memories'] : []; },
  };
  const removal: AccountRemovalActivities = {
    RemoveAccountWorkflowsActivity: async () => { log.push('stop'); return 0; },
    RemoveAccountKeepRunsActivity: async ({ keepRunsFor }) => { log.push(`keep for ${keepRunsFor}`); return 0; },
    RemoveAccountWorkspacesActivity: async () => '',
    RemoveAccountSecretsActivity: async () => 0,
    RemoveAccountMeshActivity: async () => ({ devices: 0, user: false }),
    RemoveAccountRepositoriesActivity: async () => false,
    RemoveAccountRecordsActivity: async ({ ownerId }) => { log.push(`removed ${ownerId.startsWith('space-') ? 'space' : ownerId}`); return {}; },
  };
  const run = async (body: (taskQueue: string) => Promise<void>) => {
    const taskQueue = `check-run-test-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath: resolve(__dirname, 'index.ts'),
      activities: { ...check, ...removal, CheckProgressActivity: async (args: CheckProgressArgs) => { progress.push(args); } },
    });
    await worker.runUntil(() => body(taskQueue));
  };
  return { log, progress, run };
}

describe('running checks through Temporal', () => {
  it('gives each scenario its own space, keeps its runs, removes the space, and records progress as it goes', async () => {
    const { log, progress, run } = harness(async ({ scenario: chosen }) => {
      if (chosen.id === 'b') throw new Error('the run would not start: there is no agent called "research"');
      return { result: passed(chosen.id), runIds: [`run-${chosen.id}`, `run-${chosen.id}-child`] };
    });
    await run(async (taskQueue) => {
      const outcome = await env.client.workflow.execute('CheckRunWorkflow', {
        workflowId: 'check-run-1', taskQueue,
        args: [{ checkRunId: 'c1', person: 'bo', scenarios: [scenario('a'), scenario('b')], tools: [] }],
      }) as CheckRunOutcome;

      expect(outcome.cancelled).toBe(false);
      expect(outcome.results.map((result) => [result.scenarioId, result.passed, result.error])).toEqual([
        ['a', true, undefined],
        ['b', false, 'the run would not start: there is no agent called "research"'],
      ]);
    });
    expect(log).toEqual(['space a', 'stop', 'keep for bo', 'removed space', 'gone?', 'space b', 'stop', 'keep for bo', 'removed space', 'gone?']);
    expect(progress.map((entry) => entry.running ?? entry.result?.scenarioId)).toEqual(['a', 'a', 'b', 'b']);
  }, 60_000);

  it('stops on cancel, and still removes the space it was in', async () => {
    let entered: () => void = () => undefined;
    const inside = new Promise<void>((done) => { entered = done; });
    const { log, run } = harness(async () => {
      entered();
      const context = Context.current();
      while (!context.cancellationSignal.aborted) {
        context.heartbeat();
        await new Promise((tick) => setTimeout(tick, 100));
      }
      throw context.cancellationSignal.reason;
    });
    await run(async (taskQueue) => {
      const handle = await env.client.workflow.start('CheckRunWorkflow', {
        workflowId: 'check-run-2', taskQueue,
        args: [{ checkRunId: 'c2', person: 'bo', scenarios: [scenario('a'), scenario('b')], tools: [] }],
      });
      await inside;
      await handle.signal('cancelCheck');
      const outcome = await handle.result() as CheckRunOutcome;
      expect(outcome).toEqual({ cancelled: true, results: [] });
    });
    expect(log).toEqual(['space a', 'stop', 'keep for bo', 'removed space', 'gone?']);
  }, 60_000);

  it('repeats a turn check in one space, and passes it when enough attempts pass', async () => {
    const spaces = new Set<string>();
    let tries = 0;
    const { log, run } = harness(async ({ scenario: chosen, spaceId }) => {
      spaces.add(spaceId);
      tries += 1;
      const ok = tries !== 2;
      return { result: { ...passed(chosen.id), runId: `run-${tries}`, passed: ok, checks: [{ what: 'chooses read_file', passed: ok, detail: ok ? 'it called read_file' : 'called list_dir instead of read_file' }] }, runIds: [`run-${tries}`] };
    });
    await run(async (taskQueue) => {
      const outcome = await env.client.workflow.execute('CheckRunWorkflow', {
        workflowId: 'check-run-3', taskQueue,
        args: [{ checkRunId: 'c3', person: 'bo', scenarios: [{ ...scenario('t'), turn: true, repeats: 3, passAt: 2 }], tools: [] }],
      }) as CheckRunOutcome;

      const [result] = outcome.results;
      expect(result!.passed).toBe(true);
      expect(result!.attempts?.map((one) => [one.runId, one.passed])).toEqual([['run-1', true], ['run-2', false], ['run-3', true]]);
      expect(result!.checks.map((check) => [check.what, check.passed])).toEqual([
        ['passes at least 2 of 3 times', true],
        ['chooses read_file — 2/3', false],
        ['its space leaves nothing behind', true],
      ]);
    });
    expect(spaces.size).toBe(1);
    expect(log).toEqual(['space t', 'stop', 'keep for bo', 'removed space', 'gone?']);
  }, 60_000);

  it('gives each attempt of a repeated run its own space, and fails it when any space leaks, whatever passAt allows', async () => {
    const spaces: string[] = [];
    const { log, run } = harness(async ({ scenario: chosen, spaceId }) => {
      spaces.push(spaceId);
      return { result: passed(chosen.id), runIds: [] };
    }, { has: (spaceId: string) => spaceId === spaces[1] } as ReadonlySet<string>);
    await run(async (taskQueue) => {
      const outcome = await env.client.workflow.execute('CheckRunWorkflow', {
        workflowId: 'check-run-4', taskQueue,
        args: [{ checkRunId: 'c4', person: 'bo', scenarios: [{ ...scenario('r'), repeats: 3, passAt: 1 }], tools: [] }],
      }) as CheckRunOutcome;

      const [result] = outcome.results;
      expect(result!.passedAttempts).toBe(3);
      expect(result!.passed).toBe(false);
      expect(result!.checks.at(-1)).toEqual({ what: 'its spaces leave nothing behind', passed: false, detail: 'left behind: 1 in memories' });
    });
    expect(new Set(spaces).size).toBe(3);
    expect(log.filter((line) => line === 'space r')).toHaveLength(3);
  }, 60_000);

  it('removes each space in a workflow owned by whoever owns the check', async () => {
    const spaces: string[] = [];
    const { run } = harness(async ({ scenario: chosen, spaceId }) => {
      spaces.push(spaceId);
      return { result: passed(chosen.id), runIds: [] };
    });
    await run(async (taskQueue) => {
      await env.client.workflow.execute('CheckRunWorkflow', {
        workflowId: 'check-run-5', taskQueue, ...startedFor('bo'),
        args: [{ checkRunId: 'c5', person: 'someone-the-input-names', scenarios: [scenario('o')], tools: [] }],
      });
      const removal = await env.client.workflow.getHandle(removeAccountWorkflowId(spaces[0]!)).describe();
      expect(ownerIn(removal.typedSearchAttributes)).toBe('bo');
    });
  }, 60_000);
});
