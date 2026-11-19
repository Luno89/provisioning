import { describe, it, expect } from 'vitest';
import type { Worker } from '@temporalio/worker';
import { clockSkippingEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { failureReason } from '../platform/lib/temporal-failure.js';
import { afterStep, DAY_MS, extendedTrial, nextTrialStep, type TrialState, type TrialStep } from '../instances/lib/pool-trial.js';

const temporal = environmentForFile(clockSkippingEnvironment);

interface TrialActivities {
  PoolTrialNextActivity: (args: { instanceId: string; now: number }) => Promise<unknown>;
  PoolTrialStepActivity: (args: { instanceId: string; step: TrialStep; now: number }) => Promise<void>;
}

const trialWorker = async (activities: TrialActivities): Promise<{ taskQueue: string; worker: Worker }> => {
  const taskQueue = uniqueName('trial');
  return { taskQueue, worker: await testWorker(temporal.env, { taskQueue, workflows: 'PoolTrialWorkflow.ts', activities }) };
};

const trialStart = (taskQueue: string) => ({ workflowId: `pool-trial-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') });

const followingRecords = (trial: { state: TrialState | null }, record: (step: TrialStep, now: number) => void): TrialActivities => ({
  PoolTrialNextActivity: async ({ now }) => (trial.state ? nextTrialStep(trial.state, now) : null),
  PoolTrialStepActivity: async ({ step, now }) => {
    record(step, now);
    trial.state = step === 'delete' ? null : afterStep(trial.state!, step, now);
  },
});

describe('a pool instance\'s trial', () => {
  it('warns, stops it at the end, warns once more and deletes it thirty days later, each at its time', async () => {
    const start = await temporal.env.currentTimeMs();
    const trial: { state: TrialState | null } = { state: { trialEndsAt: new Date(start + 14 * DAY_MS).toISOString() } };
    const done: Array<{ step: TrialStep; day: number }> = [];
    const { taskQueue, worker } = await trialWorker(followingRecords(trial, (step, now) => { done.push({ step, day: Math.round((now - start) / DAY_MS) }); }));
    await worker.runUntil(temporal.env.client.workflow.execute('PoolTrialWorkflow', trialStart(taskQueue)));
    expect(done).toEqual([
      { step: 'warn-3d', day: 11 }, { step: 'warn-1d', day: 13 }, { step: 'pause', day: 14 },
      { step: 'last-warning', day: 41 }, { step: 'delete', day: 44 },
    ]);
  });

  it('hears an extension while it waits, and starts a stopped instance again', async () => {
    const start = await temporal.env.currentTimeMs();
    const trial: { state: TrialState | null } = { state: { trialEndsAt: new Date(start + 2 * DAY_MS).toISOString() } };
    const done: TrialStep[] = [];
    const { taskQueue, worker } = await trialWorker(followingRecords(trial, (step) => { done.push(step); }));
    await worker.runUntil(async () => {
      const handle = await temporal.env.client.workflow.start('PoolTrialWorkflow', trialStart(taskQueue));
      await temporal.env.sleep(3 * DAY_MS);
      expect(done).toEqual(['warn-3d', 'warn-1d', 'pause']);
      const now = (await temporal.env.currentTimeMs());
      trial.state = extendedTrial(trial.state!, new Date(now + 10 * DAY_MS).toISOString(), now);
      await handle.signal('trialChanged');
      await temporal.env.sleep(60_000);
      expect(done).toEqual(['warn-3d', 'warn-1d', 'pause', 'resume']);
      trial.state = null;
      await handle.signal('trialChanged');
      await handle.result();
    });
  });

  it('holds every step while the instance moves, and ends once it has moved off Koala\'s servers', async () => {
    const start = await temporal.env.currentTimeMs();
    let moving = true;
    let moved = false;
    const done: TrialStep[] = [];
    const { taskQueue, worker } = await trialWorker({
      PoolTrialNextActivity: async ({ now }) => {
        if (moved) return null;
        return moving ? { hold: true } : nextTrialStep({ trialEndsAt: new Date(start + DAY_MS).toISOString() }, now);
      },
      PoolTrialStepActivity: async ({ step }) => { done.push(step); },
    });
    await worker.runUntil(async () => {
      const handle = await temporal.env.client.workflow.start('PoolTrialWorkflow', trialStart(taskQueue));
      await temporal.env.sleep(5 * DAY_MS);
      expect(done).toEqual([]);
      moved = true;
      moving = false;
      await handle.signal('trialChanged');
      await handle.result();
    });
    expect(done).toEqual([]);
  });

  const trialWith = async (next: () => Promise<null>): Promise<string> => {
    const { taskQueue, worker } = await trialWorker({ PoolTrialNextActivity: next, PoolTrialStepActivity: async () => {} });
    return worker.runUntil(temporal.env.client.workflow.execute('PoolTrialWorkflow', trialStart(taskQueue))
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
