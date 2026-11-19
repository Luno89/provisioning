import { WORKER_DEFAULTS, activityInterceptors } from '@koala/engine-core';
import { describe, it, expect } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Context } from '@temporalio/activity';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundled, clockSkippingEnvironment } from './temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAY_MS = 86_400_000;

interface Checked { attempt: number; at: number }

const watchUntilChecked = async (check: (tries: number) => void): Promise<{ checked: Checked; began: number; tries: number }> => {
  const env = await clockSkippingEnvironment();
  try {
    return await watchIn(env, check);
  } finally {
    await env.teardown();
  }
};

const watchIn = async (env: TestWorkflowEnvironment, check: (tries: number) => void): Promise<{ checked: Checked; began: number; tries: number }> => {
  const taskQueue = `dependency-watch-${Math.random().toString(36).slice(2, 8)}`;
  let tries = 0;
  let settle: (checked: Checked) => void = () => undefined;
  const checkedOnce = new Promise<Checked>((done) => { settle = done; });
  const worker = await Worker.create({
    ...WORKER_DEFAULTS, interceptors: { activity: activityInterceptors() }, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue,
    workflowBundle: await bundled(resolve(__dirname, 'DependencyWatchWorkflow.ts')),
    activities: {
      DependencyWatchActivity: async () => {
        tries += 1;
        check(tries);
        settle({ attempt: Context.current().info.attempt, at: await env.currentTimeMs() });
        return { findings: 0, due: 0 };
      },
    },
  });
  const began = await env.currentTimeMs();
  const checked = await worker.runUntil(async () => {
    const handle = await env.client.workflow.start('DependencyWatchWorkflow', { workflowId: `watch-${taskQueue}`, taskQueue, ...startedFor('root') });
    await env.connection.testService.unlockTimeSkipping({});
    try {
      return await checkedOnce;
    } finally {
      await env.connection.testService.lockTimeSkipping({});
      await handle.terminate('the test has what it needs');
    }
  });
  return { checked, began, tries };
};

describe('the daily dependency check', () => {
  it('keeps at today\'s check while what it reads cannot be reached, however many tries that takes', async () => {
    const { checked, began, tries } = await watchUntilChecked((tries) => {
      if (tries <= 6) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'ECONNREFUSED' });
    });
    expect(tries).toBe(7);
    expect(checked.attempt).toBe(7);
    expect(checked.at - began).toBeLessThan(DAY_MS);
  }, 60_000);

  it('leaves a check that fails for good until tomorrow rather than trying it again today', async () => {
    const { checked, began, tries } = await watchUntilChecked((tries) => {
      if (tries === 1) throw new Error('the inventory of release 2026.11.17 is not JSON');
    });
    expect(tries).toBe(2);
    expect(checked.attempt).toBe(1);
    expect(checked.at - began).toBeGreaterThanOrEqual(DAY_MS);
  }, 60_000);
});
