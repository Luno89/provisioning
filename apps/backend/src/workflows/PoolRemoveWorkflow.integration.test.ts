import { describe, it, expect } from 'vitest';
import { clockSkippingEnvironment } from './testing/temporal-test-env.js';
import { environmentForFile, uniqueName, testWorker } from './testing/test-worker.js';
import { startedFor } from '../platform/lib/workflow-owner.js';
import { failureReason } from '../platform/lib/temporal-failure.js';

const temporal = environmentForFile(clockSkippingEnvironment);

const remove = async (step: () => Promise<void>): Promise<string> => {
  const taskQueue = uniqueName('pool-remove');
  const worker = await testWorker(temporal.env, {
    taskQueue,
    workflows: 'PoolRemoveWorkflow.ts',
    activities: { PoolRemoveActivity: step },
  });
  return worker.runUntil(temporal.env.client.workflow.execute('PoolRemoveWorkflow', { workflowId: `pool-remove-${taskQueue}`, taskQueue, args: [{ instanceId: 'inst-1' }], ...startedFor('u1') })
    .then(() => 'removed', (error: unknown) => `failed: ${failureReason('FAILED', error)}`));
};

describe('removing a pool instance', () => {
  it('keeps removing while the pool cannot be reached, however many tries that takes', async () => {
    let tries = 0;
    expect(await remove(async () => {
      tries += 1;
      if (tries <= 11) throw Object.assign(new Error('connect ECONNREFUSED 10.43.0.1:443'), { code: 'ECONNREFUSED' });
    })).toBe('removed');
    expect(tries).toBe(12);
  });

  it('stops at once with why when removing fails for good', async () => {
    let tries = 0;
    expect(await remove(async () => { tries += 1; throw new Error('the vcluster koala-inst-1 is not the pool\'s'); })).toBe('failed: the vcluster koala-inst-1 is not the pool\'s');
    expect(tries).toBe(1);
  });
});
