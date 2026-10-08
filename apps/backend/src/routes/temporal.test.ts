import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { mountRouter, TEST_USER } from './test-harness.js';
import { temporalRouter } from './temporal.js';

const quiet = { validateStatus: () => true };

const WORKFLOWS = [
  { workflowId: 'run-mine', owner: TEST_USER.id, status: 'RUNNING' },
  { workflowId: 'run-theirs', owner: 'someone-else', status: 'RUNNING' },
  { workflowId: 'bench-idle-space-1', owner: 'platform', status: 'RUNNING' },
];

function harness(options: { user?: typeof TEST_USER; instanceOwner?: string; cancelled?: 'cancelled' | 'not-running' | 'unreachable'; systemInfo?: (request?: object) => Promise<{ serverVersion?: string }> } = {}) {
  const asked: { list: (string | undefined)[]; counts: (string | undefined)[]; cancelled: string[] } = { list: [], counts: [], cancelled: [] };
  const temporalBridge = {
    isReady: () => true,
    client: { workflowService: { getSystemInfo: options.systemInfo ?? (async () => ({ serverVersion: '1.25.0' })) } },
    listWorkflows: async (query?: string) => { asked.list.push(query); return WORKFLOWS; },
    countWorkflows: async (query?: string) => { asked.counts.push(query); return 1; },
    describeWorkflow: async (id: string) => WORKFLOWS.find((workflow) => workflow.workflowId === id) ?? null,
    getWorkflowHistory: async () => [{ id: 1 }],
    cancelWorkflow: async (id: string) => { asked.cancelled.push(id); return options.cancelled ?? 'cancelled'; },
  };
  const mounted = mountRouter({
    prefix: '/api/temporal',
    router: () => temporalRouter({ temporalBridge, ...(options.instanceOwner ? { instanceOwner: options.instanceOwner } : {}) }),
    user: options.user ?? TEST_USER,
  });
  return { asked, mounted };
}

describe('whether the page shows Temporal as connected', () => {
  it('says connected with the server\'s version, asking the way Temporal\'s client insists on', async () => {
    const { mounted } = harness({ systemInfo: async (request?: object) => {
      if (!request) throw new TypeError('request must be specified');
      return { serverVersion: '1.25.0' };
    } });
    const h = await mounted;
    expect((await axios.get(h.url('/api/temporal/status'))).data).toEqual({ connected: true, serverVersion: '1.25.0' });
    await h.close();
  });

  it('still says connected when the version cannot be read, rather than failing', async () => {
    const { mounted } = harness({ systemInfo: () => { throw new TypeError('request must be specified'); } });
    const h = await mounted;
    const status = await axios.get(h.url('/api/temporal/status'), quiet);
    expect(status.status).toBe(200);
    expect(status.data).toEqual({ connected: true });
    await h.close();
  });
});

describe('the Temporal page shows each person their own workflows', () => {
  it('asks Temporal only for the viewer\'s own, list and counts alike, even when they ask for everything', async () => {
    const { asked, mounted } = harness();
    const h = await mounted;
    const listed = await axios.get(h.url('/api/temporal/workflows'), { params: { scope: 'all' } });
    await axios.get(h.url('/api/temporal/workflows/count'), { params: { scope: 'all' } });

    expect(listed.data).toMatchObject({ all: false, canSeeAll: false });
    expect(asked.list).toEqual(['KoalaOwner = "test-user"']);
    expect(asked.counts).toContain('(KoalaOwner = "test-user") AND (ExecutionStatus="Running")');
    expect(asked.counts).toContain('KoalaOwner = "test-user"');
    await h.close();
  });

  it('gives an admin the whole namespace only when they switch to it', async () => {
    const { asked, mounted } = harness({ user: { ...TEST_USER, isAdmin: true } });
    const h = await mounted;
    expect((await axios.get(h.url('/api/temporal/workflows'))).data).toMatchObject({ all: false, canSeeAll: true });
    expect((await axios.get(h.url('/api/temporal/workflows'), { params: { scope: 'all' } })).data).toMatchObject({ all: true });
    expect(asked.list).toEqual(['KoalaOwner = "test-user"', undefined]);
    await h.close();
  });

  it('shows the owner of an instance everything on it', async () => {
    const { asked, mounted } = harness({ instanceOwner: TEST_USER.id });
    const h = await mounted;
    expect((await axios.get(h.url('/api/temporal/workflows'))).data).toMatchObject({ all: true, canSeeAll: true });
    expect(asked.list).toEqual([undefined]);
    await h.close();
  });

  it('opens, and shows the history of, only a workflow the viewer may see', async () => {
    const { mounted } = harness();
    const h = await mounted;
    expect((await axios.get(h.url('/api/temporal/workflows/run-mine'))).data.workflow.workflowId).toBe('run-mine');
    expect((await axios.get(h.url('/api/temporal/workflows/run-theirs'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/temporal/workflows/run-theirs/history'), quiet)).status).toBe(404);
    expect((await axios.get(h.url('/api/temporal/workflows/run-mine/history'))).data.events).toHaveLength(1);
    await h.close();
  });
});

describe('cancelling a workflow from the Temporal page', () => {
  it('lets the owner cancel their own, and nobody else\'s, which looks as if it is not there', async () => {
    const { asked, mounted } = harness();
    const h = await mounted;
    expect((await axios.post(h.url('/api/temporal/workflows/run-mine/cancel'), {}, quiet)).status).toBe(202);
    expect((await axios.post(h.url('/api/temporal/workflows/run-theirs/cancel'), {}, quiet)).status).toBe(404);
    expect((await axios.post(h.url('/api/temporal/workflows/bench-idle-space-1/cancel'), {}, quiet)).status).toBe(404);
    expect(asked.cancelled).toEqual(['run-mine']);
    await h.close();
  });

  it('lets an admin cancel anyone\'s, platform work included', async () => {
    const { asked, mounted } = harness({ user: { ...TEST_USER, isAdmin: true } });
    const h = await mounted;
    expect((await axios.post(h.url('/api/temporal/workflows/bench-idle-space-1/cancel'), {}, quiet)).status).toBe(202);
    expect(asked.cancelled).toEqual(['bench-idle-space-1']);
    await h.close();
  });

  it('says so when the workflow is not running, or Temporal cannot be reached', async () => {
    const stopped = harness({ cancelled: 'not-running' });
    const h = await stopped.mounted;
    expect((await axios.post(h.url('/api/temporal/workflows/run-mine/cancel'), {}, quiet)).data).toEqual({ error: 'That workflow is not running' });
    await h.close();
    const away = harness({ cancelled: 'unreachable' });
    const h2 = await away.mounted;
    expect((await axios.post(h2.url('/api/temporal/workflows/run-mine/cancel'), {}, quiet)).status).toBe(503);
    await h2.close();
  });
});
