import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundled, temporalTestEnvironment } from './temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { POOL_SETUP_HEARD } from '../instances/lib/pool-trial.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

type Signal = (name: string, ...args: unknown[]) => Promise<void>;

const run = async (activities: Record<string, (...args: never[]) => Promise<unknown>>, drive: (signal: Signal) => Promise<void> = async () => undefined) => {
  const taskQueue = `pool-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(resolve(__dirname, 'index.ts')), activities: { PoolTrialNextActivity: async () => null, PoolTrialStepActivity: async () => {}, ...activities } });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start('PoolInstanceWorkflow', { workflowId: `pool-instance-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') });
    await drive((name, ...args) => handle.signal(name, ...args));
    return handle.result().then(() => 'done', (error: Error) => error);
  });
};

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
    const trial = await env.client.workflow.getHandle('pool-trial-inst-1').describe();
    expect(trial.type).toBe('PoolTrialWorkflow');
  }, 60_000);

  it('starts the trial of an instance whose setup failed too, since setting it up again is the person\'s to ask', async () => {
    const seen: string[] = [];
    expect(await run({
      PoolHostActivity: async () => {}, PoolVclusterActivity: async () => {}, PoolProxyActivity: async () => {}, PoolChartActivity: async () => {}, PoolReadyActivity: async () => {},
      PoolFailedActivity: async () => { seen.push('placement failed'); },
      PoolSetupActivity: async ({ report }: { instanceId: string; report: ReturnType<typeof line> }) => { seen.push(`setup ${report.progress.stage} ${report.progress.state}`); return report.progress.state === 'failed' ? 'failed' : undefined; },
    }, async (signal) => { await signal(POOL_SETUP_HEARD, line('infisical', 'failed')); })).toBe('done');
    expect(seen).toEqual(['setup infisical failed']);
  }, 60_000);

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
  }, 60_000);
});
