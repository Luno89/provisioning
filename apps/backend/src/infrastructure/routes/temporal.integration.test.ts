import { describe, it, expect, beforeAll, afterAll, beforeEach, vi, type MockInstance } from 'vitest';
import axios from 'axios';
import { Client, Connection } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { mountRouter, TEST_USER } from '../../platform/routes/test-harness.js';
import { PLATFORM_OWNER, startedFor } from '../../platform/lib/workflow-owner.js';
import { anyOf, arrayWith } from '../../platform/lib/test-matchers.js';
import { realTemporalEnvironment } from '../../workflows/temporal-test-env.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import { temporalRouter } from './temporal.js';
import { testDataDir } from '../../platform/testing/data-dir.js';

const quiet = { validateStatus: () => true };
const { EventType } = temporal.api.enums.v1;

let env: TestWorkflowEnvironment;
let listed: MockInstance<Client['workflow']['list']>;
let counted: MockInstance<Client['workflow']['count']>;

const startOwned = (workflowId: string, owner: string) =>
  env.client.workflow.start('executePipelineRunWorkflow', { taskQueue: 'nobody-works-this-queue', workflowId, ...startedFor(owner) });

beforeAll(async () => {
  env = await realTemporalEnvironment();
  await startOwned('run-mine', TEST_USER.id);
  await startOwned('run-theirs', 'someone-else');
  await startOwned('bench-idle-space-1', PLATFORM_OWNER);
  await startOwned('run-done', TEST_USER.id);
  await env.client.workflow.getHandle('run-done').terminate('finished before anyone cancelled it');
  listed = vi.spyOn(env.client.workflow, 'list');
  counted = vi.spyOn(env.client.workflow, 'count');
});

afterAll(async () => { await env?.teardown(); });

beforeEach(() => {
  listed.mockClear();
  counted.mockClear();
});

const queriesOf = (spy: MockInstance<Client['workflow']['list']>): (string | undefined)[] => spy.mock.calls.map(([options]) => options?.query);

const bridgeOn = (db: Database, client: Client | undefined): TemporalBridge => {
  const bridge = new TemporalBridge(db, testDataDir());
  if (client) Object.assign(bridge, { client });
  return bridge;
};

function harness(options: { user?: typeof TEST_USER; instanceOwner?: string; client?: Client | 'none' } = {}) {
  return mountRouter({
    prefix: '/api/temporal',
    ...(options.instanceOwner ? { claims: { role: 'instance' as const, instanceOwnerId: options.instanceOwner } } : {}),
    router: (db) => temporalRouter({ temporalBridge: bridgeOn(db, options.client === 'none' ? undefined : options.client ?? env.client) }),
    user: options.user ?? TEST_USER,
  });
}

describe('whether the page shows Temporal as connected', () => {
  it('says connected with the server\'s version, asking the way Temporal\'s client insists on', async () => {
    const { serverVersion } = await env.client.workflowService.getSystemInfo({});
    expect(serverVersion).toBeTruthy();
    const h = await harness();
    expect((await axios.get(h.url('/api/temporal/status'))).data).toEqual({ connected: true, serverVersion });
    await h.close();
  });

  it('says not connected, and why, when Temporal does not answer', async () => {
    const connection = await Connection.connect({ address: env.connection.options.address });
    const client = new Client({ connection, namespace: env.client.options.namespace });
    await connection.close();
    const h = await harness({ client });
    const status = await axios.get(h.url('/api/temporal/status'), quiet);
    expect(status.status).toBe(200);
    expect(status.data).toEqual({ connected: false, reason: anyOf(String) });
    await h.close();
  });

  it('says not connected, and why, before the backend has connected', async () => {
    const h = await harness({ client: 'none' });
    expect((await axios.get(h.url('/api/temporal/status'), quiet)).data).toEqual({ connected: false, reason: 'the backend has not connected to Temporal yet' });
    await h.close();
  });
});

describe('the Temporal page shows each person their own workflows', () => {
  it('asks Temporal only for the viewer\'s own, list and counts alike, even when they ask for everything', async () => {
    const h = await harness();
    const answer = await axios.get<{ all: boolean; workflows: { workflowId: string }[] }>(h.url('/api/temporal/workflows'), { params: { scope: 'all' } });
    await axios.get(h.url('/api/temporal/workflows/count'), { params: { scope: 'all' } });

    expect(answer.data).toMatchObject({ all: false});
    expect(answer.data.workflows.map((workflow) => workflow.workflowId).sort()).toEqual(['run-done', 'run-mine']);
    expect(queriesOf(listed)).toEqual(['KoalaOwner = "test-user"']);
    expect(counted.mock.calls.map(([query]) => query)).toContain('(KoalaOwner = "test-user") AND (ExecutionStatus="Running")');
    expect(counted.mock.calls.map(([query]) => query)).toContain('KoalaOwner = "test-user"');
    await h.close();
  });

  it('gives an admin the whole namespace only when they switch to it', async () => {
    const h = await harness({ user: { ...TEST_USER, roles: ['operator' as const] } });
    expect((await axios.get(h.url('/api/temporal/workflows'))).data).toMatchObject({ all: false});
    expect((await axios.get(h.url('/api/temporal/workflows'), { params: { scope: 'all' } })).data).toMatchObject({ all: true });
    expect(queriesOf(listed)).toEqual(['KoalaOwner = "test-user"', undefined]);
    await h.close();
  });

  it('shows the owner of an instance everything on it', async () => {
    const h = await harness({ instanceOwner: TEST_USER.id });
    const answer = await axios.get<{ all: boolean; workflows: { workflowId: string }[] }>(h.url('/api/temporal/workflows'));
    expect(answer.data).toMatchObject({ all: true});
    expect(answer.data.workflows.map((workflow) => workflow.workflowId)).toEqual(arrayWith(['run-mine', 'run-theirs', 'bench-idle-space-1']));
    expect(queriesOf(listed)).toEqual([undefined]);
    await h.close();
  });

  it('opens, and shows the history of, only a workflow the viewer may see', async () => {
    const h = await harness();
    expect((await axios.get<{ workflow: { workflowId: string } }>(h.url('/api/temporal/workflows/run-mine'))).data.workflow.workflowId).toBe('run-mine');
    expect((await axios.get(h.url('/api/temporal/workflows/run-theirs'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/temporal/workflows/run-theirs/history'), quiet)).status).toBe(404);
    expect((await axios.get<{ events: { type: number }[] }>(h.url('/api/temporal/workflows/run-mine/history'))).data.events.map((event) => event.type)).toEqual([EventType.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED, EventType.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED]);
    await h.close();
  });
});

const cancelRequested = async (workflowId: string): Promise<boolean> => {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return (history.events ?? []).some((event) => event.workflowExecutionCancelRequestedEventAttributes);
};

describe('cancelling a workflow from the Temporal page', () => {
  it('lets the owner cancel their own, and nobody else\'s, which looks as if it is not there', async () => {
    const h = await harness();
    expect((await axios.post(h.url('/api/temporal/workflows/run-mine/cancel'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/temporal/workflows/run-theirs/cancel'), {}, quiet)).status).toBe(404);
    expect((await axios.post(h.url('/api/temporal/workflows/bench-idle-space-1/cancel'), {}, quiet)).status).toBe(404);
    expect([await cancelRequested('run-mine'), await cancelRequested('run-theirs'), await cancelRequested('bench-idle-space-1')]).toEqual([true, false, false]);
    await h.close();
  });

  it('lets an admin cancel anyone\'s, platform work included', async () => {
    const h = await harness({ user: { ...TEST_USER, roles: ['operator' as const] } });
    expect((await axios.post(h.url('/api/temporal/workflows/bench-idle-space-1/cancel'), {}, quiet)).status).toBe(202);
    expect([await cancelRequested('bench-idle-space-1'), await cancelRequested('run-theirs')]).toEqual([true, false]);
    await h.close();
  });

  it('says so when the workflow is not running, or Temporal cannot be reached', async () => {
    const h = await harness();
    expect((await axios.post(h.url('/api/temporal/workflows/run-done/cancel'), {}, quiet)).data).toEqual({ error: 'That workflow is not running' });
    await h.close();
    const h2 = await harness({ client: 'none' });
    expect((await axios.post(h2.url('/api/temporal/workflows/run-mine/cancel'), {}, quiet)).status).toBe(503);
    await h2.close();
  });
});
