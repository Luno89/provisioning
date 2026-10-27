import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { Context } from '@temporalio/activity';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { temporalTestEnvironment } from '../../workflows/temporal-test-env.js';
import { MachineTemporalGateway } from './MachineTemporalGateway.js';

let env: TestWorkflowEnvironment;
let gateway: MachineTemporalGateway;
let address = '';
const refusals: string[] = [];

beforeAll(async () => {
  env = await temporalTestEnvironment();
  gateway = new MachineTemporalGateway({
    upstream: env.address,
    namespace: env.namespace ?? 'default',
    keys: () => ['the-key'],
    deviceOf: async (token) => ({ 'token-d1': { id: 'd1' }, 'token-d2': { id: 'd2' } } as Record<string, { id: string }>)[token],
    log: (line) => refusals.push(line),
  });
  address = `127.0.0.1:${await gateway.listen(0, '127.0.0.1')}`;
}, 120_000);

afterAll(async () => {
  await gateway?.close();
  await env?.teardown();
}, 60_000);

const asMachine = (token: string) => NativeConnection.connect({ address, metadata: { authorization: `Bearer ${token}` } });

const refusedWith = async (attempt: Promise<unknown>, said: RegExp) => {
  const err = await attempt.then(() => undefined, (failure: unknown) => failure);
  const chain: string[] = [];
  for (let at = err as { message?: string; details?: string; cause?: unknown } | undefined; at; at = at.cause as typeof at) chain.push(at.details ?? '', at.message ?? '');
  expect(chain.join(' | ')).toMatch(said);
};

describe('a machine reaching Temporal through the gateway', () => {
  it('takes its own work, heartbeats and answers it, as if it spoke to Temporal itself', async () => {
    const machine = await Worker.create({
      connection: await asMachine('token-d1'),
      taskQueue: 'device-d1',
      activities: { Echo: async (text: string) => { Context.current().heartbeat(); return `machine says ${text}`; } },
    });
    const workflows = await Worker.create({ connection: env.nativeConnection, taskQueue: 'gateway-test', workflowsPath: resolve(__dirname, 'MachineTemporalGateway.fixture-workflow.ts') });
    const answer = await workflows.runUntil(machine.runUntil(env.client.workflow.execute('askMachine', { taskQueue: 'gateway-test', workflowId: `ask-${Date.now()}`, args: ['d1', 'hello'] })));
    expect(answer).toBe('machine says hello');
  }, 120_000);

  it('never lets a machine take another machine\'s work', async () => {
    const thief = await Worker.create({ connection: await asMachine('token-d2'), taskQueue: 'device-d1', activities: { Echo: async () => 'stolen' } });
    await thief.runUntil(new Promise((done) => setTimeout(done, 3_000)));
    expect(refusals.some((line) => line.includes('refused PollActivityTaskQueue from d2: a machine takes work only from its own queue, device-d2'))).toBe(true);
  }, 60_000);

  it('refuses everything else a machine might ask, and anyone without a machine\'s token', async () => {
    const client = new Client({ connection: await Connection.connect({ address, metadata: { authorization: 'Bearer token-d1' } }), namespace: env.namespace ?? 'default' });
    await refusedWith(client.workflow.list()[Symbol.asyncIterator]().next(), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.start('askMachine', { taskQueue: 'gateway-test', workflowId: 'not-allowed', args: ['d1', 'x'] }), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.workflow.getHandle('anything').signal('cancelRun'), /machine asks Temporal only for its own work|UNIMPLEMENTED/);
    await refusedWith(client.activity.complete(Buffer.from('a-forged-task-token'), 'done'), /tasks it was handed|PERMISSION_DENIED/);
    await refusedWith(Connection.connect({ address, metadata: { authorization: 'Bearer not-a-machine' } }), /this machine is not known here; add it again from My Machines/);
    await refusedWith(Connection.connect({ address }), /this machine is not known here/);
  }, 60_000);
});
