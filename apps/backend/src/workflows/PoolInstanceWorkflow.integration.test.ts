import { describe, it, expect } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { clockSkippingEnvironment, temporalTestEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, testWorker, uniqueName } from './testing/test-worker.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { POOL_SETUP_HEARD } from '../instances/lib/pool-trial.js';

const file = environmentForFile(temporalTestEnvironment);

type Signal = (name: string, ...args: unknown[]) => Promise<void>;

const run = async (activities: Record<string, (...args: never[]) => Promise<unknown>>, drive: (signal: Signal) => Promise<void> = async () => undefined, world: TestWorkflowEnvironment = file.env) => {
  const taskQueue = uniqueName('pool');
  const worker = await testWorker(world, { taskQueue, workflows: 'index.ts', activities: { PoolTrialNextActivity: async () => null, PoolTrialStepActivity: async () => {}, ...activities } });
  return worker.runUntil(async () => {
    const handle = await world.client.workflow.start('PoolInstanceWorkflow', { workflowId: `pool-instance-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') });
    await drive((name, ...args) => handle.signal(name, ...args));
    return handle.result().then(() => 'done', (error: Error) => error);
  });
};

const ownWorld = async <T>(use: (world: TestWorkflowEnvironment) => Promise<T>): Promise<T> => {
  const world = await clockSkippingEnvironment();
  try {
    return await use(world);
  } finally {
    await world.teardown();
  }
};

const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 10.43.0.1:443'), { code: 'ECONNREFUSED' });

const line = (stage: string, state: string) => ({ revision: 1, progress: { stage, title: stage, state } });

describe('installing a pool instance', () => {
  it('readies the node, makes the vcluster, opens its ports, installs Koala, waits for it to answer and then for it to set itself up, in that order, before the trial starts', async () => {
    const seen: string[] = [];
    const step = (name: string) => async (args?: { instanceId: string }) => { seen.push(args ? `${name} ${args.instanceId}` : name); };
    expect(await run({
      PoolHostActivity: step('host'), PoolVclusterActivity: step('vcluster'), PoolProxyActivity: step('proxy'),
      PoolChartActivity: step('chart'), PoolReadyActivity: step('ready'), PoolFailedActivity: step('failed'),
      PoolSetupActivity: async ({ report }: { instanceId: string; report: ReturnType<typeof line> }) => {
        seen.push(`setup ${report.progress.stage} ${report.progress.state}`);
        return report.progress.stage === 'set-up' ? 'up' : undefined;
      },
    }, async (signal) => {
      await signal(POOL_SETUP_HEARD, line('gitea', 'started'));
      await signal(POOL_SETUP_HEARD, line('gitea', 'done'));
      await signal(POOL_SETUP_HEARD, line('set-up', 'done'));
    })).toBe('done');
    expect(seen).toEqual(['host', 'vcluster inst-1', 'proxy', 'chart inst-1', 'ready inst-1', 'setup gitea started', 'setup gitea done', 'setup set-up done']);
    const trial = await file.env.client.workflow.getHandle('pool-trial-inst-1').describe();
    expect(trial.type).toBe('PoolTrialWorkflow');
  });

  it('starts the trial of an instance whose setup failed too, since setting it up again is the person\'s to ask', async () => {
    const seen: string[] = [];
    expect(await run({
      PoolHostActivity: async () => {}, PoolVclusterActivity: async () => {}, PoolProxyActivity: async () => {}, PoolChartActivity: async () => {}, PoolReadyActivity: async () => {},
      PoolFailedActivity: async () => { seen.push('placement failed'); },
      PoolSetupActivity: async ({ report }: { instanceId: string; report: ReturnType<typeof line> }) => { seen.push(`setup ${report.progress.stage} ${report.progress.state}`); return report.progress.state === 'failed' ? 'failed' : undefined; },
    }, async (signal) => { await signal(POOL_SETUP_HEARD, line('infisical', 'failed')); })).toBe('done');
    expect(seen).toEqual(['setup infisical failed']);
  });

  it('records why it failed on the instance, so the person sees it and can try again', async () => {
    const failed: string[] = [];
    const outcome = await run({
      PoolHostActivity: async () => { throw ApplicationFailure.nonRetryable('the pool\'s node has no gVisor runtime yet', 'NoGvisor'); },
      PoolVclusterActivity: async () => { throw new Error('never reached'); },
      PoolProxyActivity: async () => {}, PoolChartActivity: async () => {}, PoolReadyActivity: async () => {},
      PoolFailedActivity: async ({ reason }: { instanceId: string; reason: string }) => { failed.push(reason); },
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(failed).toEqual(['the pool\'s node has no gVisor runtime yet']);
  });

  it('keeps at each step while what it needs cannot be reached, however many tries that takes', async () => {
    let tries = 0;
    const seen: string[] = [];
    expect(await ownWorld((world) => run({
      PoolHostActivity: async () => {}, PoolProxyActivity: async () => {}, PoolChartActivity: async () => {}, PoolReadyActivity: async () => {},
      PoolVclusterActivity: async () => { tries += 1; if (tries <= 4) throw unreachable(); seen.push('vcluster'); },
      PoolFailedActivity: async () => { seen.push('placement failed'); },
      PoolSetupActivity: async () => 'up',
    }, async (signal) => { await signal(POOL_SETUP_HEARD, line('set-up', 'done')); }, world))).toBe('done');
    expect(tries).toBe(5);
    expect(seen).toEqual(['vcluster']);
  });

  it('fails a step at once when it fails for good, and keeps recording why until the record is written', async () => {
    let tries = 0;
    let records = 0;
    const failed: string[] = [];
    const outcome = await ownWorld((world) => run({
      PoolHostActivity: async () => { tries += 1; throw new Error('the pool has no node labelled koala.dev/pool'); },
      PoolVclusterActivity: async () => {}, PoolProxyActivity: async () => {}, PoolChartActivity: async () => {}, PoolReadyActivity: async () => {},
      PoolFailedActivity: async ({ reason }: { instanceId: string; reason: string }) => { records += 1; if (records <= 11) throw unreachable(); failed.push(reason); },
    }, undefined, world));
    expect(outcome).toBeInstanceOf(Error);
    expect(tries).toBe(1);
    expect(records).toBe(12);
    expect(failed).toEqual(['the pool has no node labelled koala.dev/pool']);
  });
});
