import { describe, expect, it } from 'vitest';
import { mock, type MockProxy } from 'vitest-mock-extended';
import { temporalRouter, type TemporalRouterDeps } from './temporal.js';
import { callRouter, OPERATOR, PERSON, type CallingUser } from '../testing/call-router.js';

type Bridge = TemporalRouterDeps['temporalBridge'];
type BridgeMock = MockProxy<Bridge> & Bridge;

const WORKFLOWS = [
  { workflowId: 'run-mine', owner: PERSON.id, status: 'RUNNING' },
  { workflowId: 'run-theirs', owner: 'someone-else', status: 'RUNNING' },
  { workflowId: 'bench-idle-space-1', owner: 'platform', status: 'RUNNING' },
];

function bridge(options: { cancelled?: 'cancelled' | 'not-running' | 'unreachable'; ready?: boolean; systemInfo?: (request: object) => Promise<{ serverVersion?: string }> } = {}): BridgeMock {
  const temporalBridge = mock<Bridge>();
  temporalBridge.isReady.mockReturnValue(options.ready ?? true);
  temporalBridge.client = { workflowService: { getSystemInfo: options.systemInfo ?? (async () => ({ serverVersion: '1.25.0' })) } };
  temporalBridge.listWorkflows.mockResolvedValue(WORKFLOWS);
  temporalBridge.countWorkflows.mockResolvedValue(1);
  temporalBridge.describeWorkflow.mockImplementation(async (id) => WORKFLOWS.find((workflow) => workflow.workflowId === id) ?? null);
  temporalBridge.getWorkflowHistory.mockResolvedValue([{ id: 1 }]);
  temporalBridge.cancelWorkflow.mockResolvedValue(options.cancelled ?? 'cancelled');
  return temporalBridge;
}

const as = (user: CallingUser | null, temporalBridge: Bridge, claims?: { role: 'instance'; instanceOwnerId: string }) =>
  (path: string, method: 'GET' | 'POST' = 'GET') => callRouter(temporalRouter({ temporalBridge }), '/api/temporal', { path, method, user, ...(claims ? { claims } : {}) });

describe('whether the page shows Temporal as connected', () => {
  it('says connected with the server\'s version, asking the way Temporal\'s client insists on', async () => {
    const systemInfo = async (request: object) => {
      if (!request) throw new TypeError('request must be specified');
      return { serverVersion: '1.25.0' };
    };
    expect((await as(PERSON, bridge({ systemInfo }))('/status')).body).toEqual({ connected: true, serverVersion: '1.25.0' });
  });

  it('still says connected when the version cannot be read, rather than failing', async () => {
    const answer = await as(PERSON, bridge({ systemInfo: () => { throw new TypeError('request must be specified'); } }))('/status');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ connected: true });
  });

  it('says not connected, without asking for a version, when Temporal is not ready', async () => {
    const temporalBridge = bridge({ ready: false });
    expect((await as(PERSON, temporalBridge)('/status')).body).toEqual({ connected: false });
  });
});

describe('the Temporal page shows each person their own workflows', () => {
  it('asks Temporal only for the viewer\'s own, list and counts alike, even when they ask for everything', async () => {
    const temporalBridge = bridge();
    const asOwner = as(PERSON, temporalBridge);
    const listed = await asOwner('/workflows?scope=all');
    await asOwner('/workflows/count?scope=all');
    expect(listed.body).toMatchObject({ all: false });
    expect(temporalBridge.listWorkflows).toHaveBeenCalledWith('KoalaOwner = "person-1"', 50);
    expect(temporalBridge.countWorkflows).toHaveBeenCalledWith('(KoalaOwner = "person-1") AND (ExecutionStatus="Running")');
    expect(temporalBridge.countWorkflows).toHaveBeenCalledWith('KoalaOwner = "person-1"');
  });

  it('adds up the counts by how each workflow ended', async () => {
    const temporalBridge = bridge();
    temporalBridge.countWorkflows.mockImplementation(async (query) => (query?.includes('Failed') ? 3 : 1));
    expect((await as(PERSON, temporalBridge)('/workflows/count')).body).toEqual({ total: 1, running: 1, completed: 1, failed: 3, timedOut: 1 });
  });

  it('pages as many workflows as were asked for', async () => {
    const temporalBridge = bridge();
    await as(PERSON, temporalBridge)('/workflows?pageSize=7');
    expect(temporalBridge.listWorkflows).toHaveBeenCalledWith('KoalaOwner = "person-1"', 7);
  });

  it('gives an operator the whole namespace only when they switch to it', async () => {
    const temporalBridge = bridge();
    const asOperator = as(OPERATOR, temporalBridge);
    expect((await asOperator('/workflows')).body).toMatchObject({ all: false });
    expect((await asOperator('/workflows?scope=all')).body).toMatchObject({ all: true });
    expect(temporalBridge.listWorkflows).toHaveBeenNthCalledWith(1, 'KoalaOwner = "operator-1"', 50);
    expect(temporalBridge.listWorkflows).toHaveBeenNthCalledWith(2, undefined, 50);
  });

  it('shows the owner of an instance everything on it', async () => {
    const temporalBridge = bridge();
    const answer = await as(PERSON, temporalBridge, { role: 'instance', instanceOwnerId: PERSON.id })('/workflows');
    expect(answer.body).toMatchObject({ all: true });
    expect(temporalBridge.listWorkflows).toHaveBeenCalledWith(undefined, 50);
  });

  it('opens, and shows the history of, only a workflow the viewer may see', async () => {
    const asOwner = as(PERSON, bridge());
    expect(((await asOwner('/workflows/run-mine')).body as { workflow: { workflowId: string } }).workflow.workflowId).toBe('run-mine');
    expect((await asOwner('/workflows/run-theirs')).status).toBe(404);
    expect((await asOwner('/workflows/run-theirs/history')).status).toBe(404);
    expect(((await asOwner('/workflows/run-mine/history')).body as { events: unknown[] }).events).toHaveLength(1);
  });

  it('says the workflow is not found when Temporal has no history for one the viewer may see', async () => {
    const temporalBridge = bridge();
    temporalBridge.getWorkflowHistory.mockResolvedValue(null);
    expect((await as(PERSON, temporalBridge)('/workflows/run-mine/history')).status).toBe(404);
  });
});

describe('cancelling a workflow from the Temporal page', () => {
  it('lets the owner cancel their own, and nobody else\'s, which looks as if it is not there', async () => {
    const temporalBridge = bridge();
    const asOwner = as(PERSON, temporalBridge);
    expect((await asOwner('/workflows/run-mine/cancel', 'POST')).status).toBe(202);
    expect((await asOwner('/workflows/run-theirs/cancel', 'POST')).status).toBe(404);
    expect((await asOwner('/workflows/bench-idle-space-1/cancel', 'POST')).status).toBe(404);
    expect(temporalBridge.cancelWorkflow).toHaveBeenCalledTimes(1);
    expect(temporalBridge.cancelWorkflow).toHaveBeenCalledWith('run-mine');
  });

  it('lets an operator cancel anyone\'s, platform work included', async () => {
    const temporalBridge = bridge();
    expect((await as(OPERATOR, temporalBridge)('/workflows/bench-idle-space-1/cancel', 'POST')).status).toBe(202);
    expect(temporalBridge.cancelWorkflow).toHaveBeenCalledWith('bench-idle-space-1');
  });

  it('says so when the workflow is not running, or Temporal cannot be reached', async () => {
    expect((await as(PERSON, bridge({ cancelled: 'not-running' }))('/workflows/run-mine/cancel', 'POST')).body).toEqual({ error: 'That workflow is not running' });
    expect((await as(PERSON, bridge({ cancelled: 'unreachable' }))('/workflows/run-mine/cancel', 'POST')).status).toBe(503);
  });
});
