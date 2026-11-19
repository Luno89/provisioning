import { readFileSync } from 'node:fs';
import { Client } from '@temporalio/client';
import { temporal as proto } from '@temporalio/proto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connectTemporal } from './temporal.js';
import { queueFor, temporal, testClient, testWorker, workflowBundle, type TestTemporal } from '../testing/temporal.js';
import { echoed } from '../testing/workflows.js';

let env: TestTemporal;

beforeAll(async () => { env = await temporal(); });
afterAll(async () => { await env.teardown(); });

const failedTasks = async (workflowId: string): Promise<string[]> => {
  const { history } = await env.client.workflowService.getWorkflowExecutionHistory({ namespace: env.namespace ?? 'default', execution: { workflowId } });
  return (history?.events ?? [])
    .filter((event) => event.eventType === proto.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_TASK_FAILED)
    .map((event) => event.workflowTaskFailedEventAttributes?.failure?.message ?? '');
};

describe('a worker Koala builds', () => {
  it('takes work a Koala client sealed and hands back what was sent', async () => {
    const taskQueue = queueFor('sealed');
    const worker = await testWorker(env, { taskQueue, workflowBundle: await workflowBundle(), activities: { echo: async (given: unknown) => given } });
    const result = await worker.runUntil(testClient(env).workflow.execute(echoed, { taskQueue, workflowId: queueFor('sealed-run'), args: [{ said: 'hello' }] }));
    expect(result).toEqual({ said: 'hello' });
  });

  it('refuses a workflow whose input arrived unsealed, so a payload production would refuse is refused here too', async () => {
    const taskQueue = queueFor('unsealed');
    const workflowId = queueFor('unsealed-run');
    const worker = await testWorker(env, { taskQueue, workflowBundle: await workflowBundle(), activities: { echo: async (given: unknown) => given } });
    const plain = new Client({ connection: env.connection, namespace: env.namespace ?? 'default' });
    const settled = async (): Promise<boolean> => (await failedTasks(workflowId)).length > 0 || (await plain.workflow.getHandle(workflowId).describe()).status.name !== 'RUNNING';
    await worker.runUntil(async () => {
      await plain.workflow.start(echoed, { taskQueue, workflowId, args: ['in the clear'] });
      while (!(await settled())) await new Promise((done) => setTimeout(done, 100));
    });
    expect((await plain.workflow.getHandle(workflowId).describe()).status.name).toBe('RUNNING');
    expect((await failedTasks(workflowId))[0]).toMatch(/arrived unencrypted/);
  });
});

describe('dialling Temporal', () => {
  const ca = (): string => readFileSync(inject('temporalCa'), 'utf8');
  const auth = { apiKey: () => 'a-key', renewEveryMs: 60_000 };
  const dialled = (side: 'client' | 'worker', address: string) => {
    const dial = { address, tls: { ca: ca(), serverName: 'koala-temporal' }, auth };
    return side === 'client' ? connectTemporal(dial, 'client') : connectTemporal(dial, 'worker');
  };

  for (const side of ['client', 'worker'] as const) {
    it(`reaches it over TLS through the install's own CA, on the ${side} side`, async () => {
      const connection = await dialled(side, inject('temporalTlsAddress'));
      try {
        expect((await connection.workflowService.getSystemInfo({})).capabilities).toBeTruthy();
      } finally {
        await connection.close();
      }
    });

    it(`is refused by a Temporal that answers in plaintext, on the ${side} side`, async () => {
      await expect(dialled(side, inject('temporalAddress'))).rejects.toThrow();
    });
  }
});
