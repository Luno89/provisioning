import { describe, expect, it } from 'vitest';
import { MemoryDB } from '../../platform/lib/memory-db.js';
import { WorkFailureService, type ClosedWorkflow } from './WorkFailureService.js';

const NOW = new Date('2026-10-17T12:00:00Z');

function setUp(closed: ClosedWorkflow[] = []) {
  const db = new MemoryDB();
  let now = NOW;
  const service = new WorkFailureService({
    store: db,
    workflows: {
      closedSince: async (since) => closed.filter((workflow) => workflow.closedAt > since.toISOString()),
      failureOf: async (workflowId) => ({ message: 'Workflow execution failed', cause: { message: `${workflowId} could not reach its cluster` } }),
      describeRun: async (runId) => ({ workflowId: runId.split('~')[0]!, type: 'AgentRunWorkflow', startedAt: NOW.toISOString(), memo: { runId } }),
    },
    records: async () => ({ trees: [{ id: 't1', name: 'Shop' }], projects: [{ id: 'p1', name: 'Books' }], conversations: [{ id: 'c1', title: 'Labels' }], checkRuns: [], releases: [], agentName: (slug) => (slug === 'koala' ? 'Koala' : undefined) }),
    isPerson: async (ownerId) => ownerId === 'u1',
    now: () => now,
  });
  return { db, service, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const closedWorkflow = (over: Partial<ClosedWorkflow>): ClosedWorkflow => ({
  workflowId: 'remove-project-p1', temporalRunId: 'r1', type: 'RemoveProjectWorkflow', startedAt: '2026-10-17T11:00:00Z',
  closedAt: '2026-10-17T11:30:00Z', status: 'FAILED', ownerId: 'u1', ...over,
});

describe('work that failed', () => {
  it('records a top-level run that ended failed, described the way Running describes it', async () => {
    const { service } = setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'grove-run-t1~5', outcome: 'failed', reason: 'the executor could not start its sandbox', depth: 0 });
    expect(await service.shown('u1')).toEqual([expect.objectContaining({
      id: 'run:grove-run-t1~5', kind: 'tree', title: 'Tree run: Shop', opens: { kind: 'tree', id: 't1' }, reason: 'the executor could not start its sandbox',
    })]);
  });

  it('leaves out child runs, runs that did not fail, and runs of a check\'s space', async () => {
    const { service } = setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'child', outcome: 'failed', depth: 1 });
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'interrupted', depth: 0 });
    await service.runEnded({ ownerId: 'space-1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.shown('u1')).toEqual([]);
    expect(await service.shown('space-1')).toEqual([]);
  });

  it('finds workflows Temporal closed as failed, once each, with the cause, but not deploys or platform work', async () => {
    const { service } = setUp([
      closedWorkflow({}),
      closedWorkflow({ workflowId: 'deploy-1', type: 'executeAppDeployWorkflow' }),
      closedWorkflow({ workflowId: 'sweep', type: 'SweepWorkflow', ownerId: 'platform' }),
      closedWorkflow({ workflowId: 'child', parent: 'remove-project-p1' }),
    ]);
    expect(await service.poll()).toBe(1);
    expect(await service.poll()).toBe(0);
    expect(await service.shown('u1')).toEqual([expect.objectContaining({
      id: 'workflow:remove-project-p1:r1', kind: 'removal', title: 'Deleting the project Books', reason: 'remove-project-p1 could not reach its cluster', failedAt: '2026-10-17T11:30:00Z',
    })]);
  });

  it('clears one or all, keeps a cleared one cleared, and shows only the last 7 days', async () => {
    const { service, db, later } = setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(60_000);
    await service.runEnded({ ownerId: 'u1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.clear('u1', ['run:run-a'])).toBe(1);
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    expect((await service.shown('u1')).map((failure) => failure.id)).toEqual(['run:run-b']);
    later(8 * 86_400_000);
    expect(await service.shown('u1')).toEqual([]);
    expect(await db.getWorkFailures('u1')).toHaveLength(2);
    expect(await service.clear('u1', 'all')).toBe(1);
  });

  it('forgets failures after 30 days', async () => {
    const { service, db, later } = setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(31 * 86_400_000);
    await service.poll();
    expect(await db.getWorkFailures('u1')).toEqual([]);
  });
});
