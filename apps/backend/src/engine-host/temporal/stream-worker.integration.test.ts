import { interceptorsOf, REFUSING_DELETING_WORK, untilPolling, watchedRun } from '@koala/engine-core/testing/temporal';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { testKeys } from '../../platform/testing/keys.js';
import { keepPayloadsIn } from '../../platform/lib/db-interface.js';
import { testDatabase, testDatabaseAt } from '../../platform/lib/test-database.js';
import { refuseWorkWith } from '../../platform/lib/temporal-client.js';
import { deletingMarksIn } from '../../platform/services/DeletingMarks.js';
import { createStreamActivities } from './activities.js';
import { startStreamWorker } from './stream-worker.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await realTemporalEnvironment();
  const { uri, dbName } = await testDatabaseAt();
  keepPayloadsIn({ uri, dbName });
  refuseWorkWith(deletingMarksIn(await testDatabase()));
});
afterAll(async () => { await env.teardown(); });


describe('the stream worker, started as the backend starts it', () => {
  it('connects with the platform\'s own connection, polls its queue for every stream activity, and stops when told', async () => {
    const namespace = env.namespace ?? 'default';
    const taskQueue = `stream-boot-${Date.now()}`;
    const worker = await startStreamWorker({
      services: {} as never,
      io: { to: () => ({ emit: () => true }) },
      turnLogs: { appendTurnLog: async () => undefined, lastTurnLogSeq: async () => 0 },
      deletions: { store: { deletion: async () => undefined, saveDeletionProgress: async () => false }, titles: async () => (work) => work.type },
      connection: { temporal: { address: inject('temporalTlsAddress'), namespace, caPath: inject('temporalCa') }, keys: testKeys('stream-boot') },
      taskQueue,
    });
    const { running, ended } = watchedRun(worker);
    await untilPolling(env.client, { namespace, queue: taskQueue, ended });
    expect([...(worker.options.activities as unknown as Map<string, unknown>).keys()].sort()).toEqual(Object.keys(createStreamActivities({} as never)).sort());
    expect(interceptorsOf(worker), 'the shared interceptors and the refusal of work being deleted').toEqual(REFUSING_DELETING_WORK);
    worker.shutdown();
    await running;
    expect(worker.getState()).toBe('STOPPED');
  });
});
