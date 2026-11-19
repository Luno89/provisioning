import { activityInterceptors } from '@koala/engine-core';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { bundled, clockSkippingEnvironment } from './testing/temporal-test-env.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { failureReason } from '../platform/lib/temporal-failure.js';
import { afterStep, DAY_MS, extendedTrial, nextTrialStep, type TrialState, type TrialStep } from '../instances/lib/pool-trial.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await clockSkippingEnvironment();
});

afterAll(async () => {
  await env?.teardown();
});

describe('a pool instance\'s trial', () => {
  it('warns, stops it at the end, warns once more and deletes it thirty days later, each at its time', async () => {
    const start = await env.currentTimeMs();
    let state: TrialState | null = { trialEndsAt: new Date(start + 14 * DAY_MS).toISOString() };
    const done: Array<{ step: TrialStep; day: number }> = [];
    const taskQueue = `trial-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(__dirname, 'PoolTrialWorkflow.ts')),
      activities: {
        PoolTrialNextActivity: async ({ now }: { instanceId: string; now: number }) => (state ? nextTrialStep(state, now) : null),
        PoolTrialStepActivity: async ({ step, now }: { instanceId: string; step: TrialStep; now: number }) => {
          done.push({ step, day: Math.round((now - start) / DAY_MS) });
          state = step === 'delete' ? null : afterStep(state!, step, now);
        },
      },
    });
    await worker.runUntil(env.client.workflow.execute('PoolTrialWorkflow', {
      workflowId: `pool-trial-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1'),
    }));
    expect(done).toEqual([
      { step: 'warn-3d', day: 11 }, { step: 'warn-1d', day: 13 }, { step: 'pause', day: 14 },
      { step: 'last-warning', day: 41 }, { step: 'delete', day: 44 },
    ]);
  });

  it('hears an extension while it waits, and starts a stopped instance again', async () => {
    const start = await env.currentTimeMs();
    let state: TrialState | null = { trialEndsAt: new Date(start + 2 * DAY_MS).toISOString() };
    const done: TrialStep[] = [];
    const taskQueue = `trial-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(__dirname, 'PoolTrialWorkflow.ts')),
      activities: {
        PoolTrialNextActivity: async ({ now }: { instanceId: string; now: number }) => (state ? nextTrialStep(state, now) : null),
        PoolTrialStepActivity: async ({ step, now }: { instanceId: string; step: TrialStep; now: number }) => {
          done.push(step);
          state = step === 'delete' ? null : afterStep(state!, step, now);
        },
      },
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('PoolTrialWorkflow', {
        workflowId: `pool-trial-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1'),
      });
      await env.sleep(3 * DAY_MS);
      expect(done).toEqual(['warn-3d', 'warn-1d', 'pause']);
      const now = (await env.currentTimeMs());
      state = extendedTrial(state!, new Date(now + 10 * DAY_MS).toISOString(), now);
      await handle.signal('trialChanged');
      await env.sleep(60_000);
      expect(done).toEqual(['warn-3d', 'warn-1d', 'pause', 'resume']);
      state = null;
      await handle.signal('trialChanged');
      await handle.result();
    });
  });

  it('holds every step while the instance moves, and ends once it has moved off Koala\'s servers', async () => {
    const start = await env.currentTimeMs();
    let moving = true;
    let moved = false;
    const done: TrialStep[] = [];
    const taskQueue = `trial-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(__dirname, 'PoolTrialWorkflow.ts')),
      activities: {
        PoolTrialNextActivity: async ({ now }: { instanceId: string; now: number }) => {
          if (moved) return null;
          return moving ? { hold: true } : nextTrialStep({ trialEndsAt: new Date(start + DAY_MS).toISOString() }, now);
        },
        PoolTrialStepActivity: async ({ step }: { instanceId: string; step: TrialStep; now: number }) => { done.push(step); },
      },
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start('PoolTrialWorkflow', { workflowId: `pool-trial-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') });
      await env.sleep(5 * DAY_MS);
      expect(done).toEqual([]);
      moved = true;
      moving = false;
      await handle.signal('trialChanged');
      await handle.result();
    });
    expect(done).toEqual([]);
  });

  const trialWith = async (next: () => Promise<null>): Promise<string> => {
    const taskQueue = `trial-${Math.random().toString(36).slice(2, 8)}`;
    const worker = await Worker.create({
      interceptors: { activity: activityInterceptors() },
      ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default',
      taskQueue,
      workflowBundle: await bundled(resolve(__dirname, 'PoolTrialWorkflow.ts')),
      activities: { PoolTrialNextActivity: next, PoolTrialStepActivity: async () => {} },
    });
    return worker.runUntil(env.client.workflow.execute('PoolTrialWorkflow', { workflowId: `pool-trial-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') })
      .then(() => 'ended', (error: unknown) => `failed: ${failureReason('FAILED', error)}`));
  };

  it('keeps asking what is due while the records cannot be reached, however many tries that takes', async () => {
    let tries = 0;
    expect(await trialWith(async () => {
      tries += 1;
      if (tries <= 21) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:27017'), { code: 'ECONNREFUSED' });
      return null;
    })).toBe('ended');
    expect(tries).toBe(22);
  });

  it('stops at once with why when asking what is due fails for good', async () => {
    let tries = 0;
    expect(await trialWith(async () => { tries += 1; throw new Error('the instance inst-1 has no trial'); })).toBe('failed: the instance inst-1 has no trial');
    expect(tries).toBe(1);
  });
});
