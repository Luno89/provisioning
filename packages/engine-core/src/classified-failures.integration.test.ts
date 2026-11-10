import { Context } from '@temporalio/activity';
import { ActivityFailure, ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifiedFailures } from './classified-failures.js';
import { queueFor, temporal, workflowBundle } from '../testing/temporal.js';
import { failingUntil } from '../testing/workflows.js';

let env: TestWorkflowEnvironment;

beforeAll(async () => { env = await temporal(); });
afterAll(async () => { await env.teardown(); });

const tried: Record<string, number> = {};

async function run(kind: string, until: number): Promise<number> {
  const taskQueue = queueFor('classified');
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle: await workflowBundle(),
    interceptors: { activity: [classifiedFailures()] },
    activities: {
      async waitForStop() { return ''; },
      async echo(value: unknown) { return value; },
      async fails(given: string, last: number): Promise<number> {
        const attempt = Context.current().info.attempt;
        tried[given] = attempt;
        if (attempt >= last) return attempt;
        if (given === 'temporary') throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
        if (given === 'classified') throw ApplicationFailure.retryable('the activity said so itself', 'Mine');
        throw new TypeError('cannot read properties of undefined');
      },
    },
  });
  return worker.runUntil(env.client.workflow.execute(failingUntil, { taskQueue, workflowId: queueFor('failing'), args: [kind, until, '50ms'] }));
}

const causeOf = (err: unknown): ApplicationFailure => {
  expect(err).toBeInstanceOf(WorkflowFailedError);
  const activity = (err as WorkflowFailedError).cause;
  expect(activity).toBeInstanceOf(ActivityFailure);
  return (activity as ActivityFailure).cause as ApplicationFailure;
};

describe('how an activity\'s failure is retried', () => {
  it('retries a failure that is temporary, with no cap on the attempts, until the dependency answers', async () => {
    expect(await run('temporary', 6)).toBe(6);
  });

  it('fails at once on a final failure such as a bug, keeping its type and words, and never tries it again', async () => {
    const err = await run('bug', 50).catch((failed: unknown) => failed);
    const cause = causeOf(err);
    expect(cause.nonRetryable).toBe(true);
    expect(cause.type).toBe('TypeError');
    expect(cause.message).toBe('cannot read properties of undefined');
    expect(tried.bug).toBe(1);
  });

  it('leaves a failure the activity classified itself as it is', async () => {
    expect(await run('classified', 3)).toBe(3);
  });
});
