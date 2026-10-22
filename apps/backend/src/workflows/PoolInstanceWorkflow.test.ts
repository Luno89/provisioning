import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { ApplicationFailure } from '@temporalio/common';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { temporalTestEnvironment } from './temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await temporalTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const run = async (activities: Record<string, (...args: never[]) => Promise<unknown>>) => {
  const taskQueue = `pool-${Math.random().toString(36).slice(2, 8)}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: resolve(__dirname, 'index.ts'), activities: { PoolTrialNextActivity: async () => null, PoolTrialStepActivity: async () => {}, ...activities } });
  return worker.runUntil(env.client.workflow.execute('PoolInstanceWorkflow', {
    workflowId: `pool-instance-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1'),
  }).then(() => 'done', (error: Error) => error));
};

describe('installing a pool instance', () => {
  it('readies the node, makes the vcluster, opens its ports, installs Koala and waits for it to answer, in that order', async () => {
    const seen: string[] = [];
    const step = (name: string) => async (args?: { instanceId: string }) => { seen.push(args ? `${name} ${args.instanceId}` : name); };
    expect(await run({
      PoolHostActivity: step('host'), PoolVclusterActivity: step('vcluster'), PoolProxyActivity: step('proxy'),
      PoolChartActivity: step('chart'), PoolReadyActivity: step('ready'), PoolFailedActivity: step('failed'),
    })).toBe('done');
    expect(seen).toEqual(['host', 'vcluster inst-1', 'proxy', 'chart inst-1', 'ready inst-1']);
    const trial = await env.client.workflow.getHandle('pool-trial-inst-1').describe();
    expect(trial.type).toBe('PoolTrialWorkflow');
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
