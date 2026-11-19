import { resolve } from 'node:path';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { WORKER_DEFAULTS } from '@koala/engine-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OWNER_ATTRIBUTE, startedFor } from '../platform/lib/workflow-owner.js';
import { bundled, realTemporalEnvironment, temporalTestEnvironment } from './testing/temporal-test-env.js';
import type * as fixtures from './testing/contract.fixture-workflow.js';

const FIXTURE = resolve(import.meta.dirname, 'testing/contract.fixture-workflow.ts');

for (const [server, make] of [['the in-memory test server', temporalTestEnvironment], ['the real Temporal server', realTemporalEnvironment]] as const) {
  describe(`Temporal as Koala relies on it, on ${server}`, () => {
    let env: TestWorkflowEnvironment;
    let attempts = 0;
    beforeAll(async () => { env = await make(); });
    afterAll(async () => { await env.teardown(); });

    const running = async <T>(work: (taskQueue: string) => Promise<T>): Promise<T> => {
      const taskQueue = `contract-${Math.random().toString(36).slice(2, 8)}`;
      const worker = await Worker.create({
        ...WORKER_DEFAULTS, connection: env.nativeConnection, namespace: env.namespace ?? 'default', taskQueue, workflowBundle: await bundled(FIXTURE),
        activities: {
          flaky: async () => { attempts += 1; if (attempts < 3) throw new Error('not yet'); return attempts; },
          refuses: async () => { throw ApplicationFailure.nonRetryable('refused for good'); },
        },
      });
      return worker.runUntil(work(taskQueue));
    };
    const start = (taskQueue: string, workflow: keyof typeof fixtures, args: unknown[] = []) =>
      env.client.workflow.start<(...given: unknown[]) => Promise<unknown>>(workflow, { taskQueue, workflowId: `${workflow}-${Math.random().toString(36).slice(2, 8)}`, args, ...startedFor('bo') });

    it('runs a child workflow and hands its result back', async () => {
      expect(await running(async (queue) => (await start(queue, 'parent')).result())).toBe('hello from the child');
    });

    it('continues as new and ends with the last run\'s result', async () => {
      expect(await running(async (queue) => (await start(queue, 'counts', [3])).result())).toBe(3);
    });

    it('takes signals in the order they were sent', async () => {
      expect(await running(async (queue) => {
        const handle = await start(queue, 'listens');
        await handle.signal('told', 'first');
        await handle.signal('told', 'second');
        return handle.result();
      })).toEqual(['first', 'second']);
    });

    it('lets a cancelled workflow run its own ending', async () => {
      expect(await running(async (queue) => {
        const handle = await start(queue, 'waitsToBeStopped');
        await handle.cancel();
        return handle.result();
      })).toBe('stopped');
    });

    it('retries an activity that fails until it succeeds, and stops at once on a non-retryable failure', async () => {
      attempts = 0;
      expect(await running(async (queue) => (await start(queue, 'retries')).result())).toBe(3);
      expect(await running(async (queue) => (await start(queue, 'stopsRetrying')).result())).toBe('refused for good');
    });

    it('takes a new workflow down the patched path, and fails one that throws a non-retryable failure', async () => {
      expect(await running(async (queue) => (await start(queue, 'patchedOrNot')).result())).toBe(true);
      const failed = await running(async (queue) => (await start(queue, 'failsForGood')).result().then(() => undefined, (err: unknown) => err));
      expect(failed).toBeInstanceOf(WorkflowFailedError);
    });

    it('keeps the owner Koala stamps on every workflow it starts', async () => {
      const owner = await running(async (queue) => {
        const handle = await start(queue, 'parent');
        await handle.result();
        return (await handle.describe()).searchAttributes[OWNER_ATTRIBUTE.name];
      });
      expect(owner).toEqual(['bo']);
    });
  });
}
