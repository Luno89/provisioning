import type { Worker } from '@temporalio/worker';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { testWorker } from '../../workflows/testing/test-worker.js';

export interface FixtureWorker {
  env: TestWorkflowEnvironment;
  stop(): Promise<void>;
}

export async function fixtureWorker(queue: string, workflowsPath: string): Promise<FixtureWorker> {
  const env = await realTemporalEnvironment();
  let worker: Worker;
  try {
    worker = await testWorker(env, { taskQueue: queue, workflows: workflowsPath });
  } catch (err) {
    await env.teardown();
    throw err;
  }
  const running = worker.run();
  return {
    env,
    async stop() {
      worker.shutdown();
      await running;
      await env.teardown();
    },
  };
}
