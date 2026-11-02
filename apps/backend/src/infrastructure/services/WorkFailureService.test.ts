import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { POLL_MS, WorkFailureService, type ClosedWorkflow, type WorkFailureDeps } from './WorkFailureService.js';

const NOW = new Date('2026-10-17T12:00:00Z');

async function setUp(closed: ClosedWorkflow[] = []) {
  const db = memoryDatabase();
  let now = NOW;
  const service = new WorkFailureService({
    store: db.infrastructure,
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
    const { service } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'grove-run-t1~5', outcome: 'failed', reason: 'the executor could not start its sandbox', depth: 0 });
    expect(await service.shown('u1')).toEqual([expect.objectContaining({
      id: 'run:grove-run-t1~5', kind: 'tree', title: 'Tree run: Shop', opens: { kind: 'tree', id: 't1' }, reason: 'the executor could not start its sandbox',
    })]);
  });

  it('leaves out child runs, runs that did not fail, and runs of a check\'s space', async () => {
    const { service } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'child', outcome: 'failed', depth: 1 });
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'interrupted', depth: 0 });
    await service.runEnded({ ownerId: 'space-1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.shown('u1')).toEqual([]);
    expect(await service.shown('space-1')).toEqual([]);
  });

  it('finds workflows Temporal closed as failed, once each, with the cause, but not deploys or platform work', async () => {
    const { service } = await setUp([
      closedWorkflow({}),
      closedWorkflow({ workflowId: 'deploy-1', type: 'executeDeployAppWorkflow' }),
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
    const { service, db, later } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(60_000);
    await service.runEnded({ ownerId: 'u1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect(await service.clear('u1', ['run:run-a'])).toBe(1);
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    expect((await service.shown('u1')).map((failure) => failure.id)).toEqual(['run:run-b']);
    later(8 * 86_400_000);
    expect(await service.shown('u1')).toEqual([]);
    expect(await db.infrastructure.getWorkFailures('u1')).toHaveLength(2);
    expect(await service.clear('u1', 'all')).toBe(1);
  });

  it('forgets failures after 30 days', async () => {
    const { service, db, later } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(31 * 86_400_000);
    await service.poll();
    expect(await db.infrastructure.getWorkFailures('u1')).toEqual([]);
  });
});

describe('watching for failed work', () => {
  afterEach(() => { vi.useRealTimers(); });

  const watching = async (closed: ClosedWorkflow[]) => {
    const { db } = await setUp();
    const log: string[] = [];
    const failed: string[] = [];
    const closedSince = vi.fn<WorkFailureDeps['workflows']['closedSince']>(async () => closed);
    const service = new WorkFailureService({
      store: db.infrastructure,
      workflows: {
        closedSince,
        failureOf: async () => undefined,
        describeRun: async () => undefined,
      },
      records: async () => { throw new Error('records are down'); },
      isPerson: async (ownerId) => ownerId === 'u1',
      now: () => NOW,
      log: (message) => log.push(message),
      onFailure: (failure) => failed.push(failure.id),
    });
    return { db, service, log, failed, closedSince };
  };

  it('polls at once when started and then every half minute, until stopped, and starts only once', async () => {
    vi.useFakeTimers();
    const { service, closedSince } = await watching([]);
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(closedSince).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(closedSince).toHaveBeenCalledTimes(2);
    service.stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(closedSince).toHaveBeenCalledTimes(2);
  });

  it('logs a poll that fails instead of stopping', async () => {
    vi.useFakeTimers();
    const { service, log, closedSince } = await watching([]);
    closedSince.mockRejectedValueOnce(new Error('temporal is away'));
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['[failures] temporal is away']);
    service.stop();
  });

  it('tells whoever listens about each failure it records, once, and describes it without the records when they cannot be read', async () => {
    const { service, failed } = await watching([closedWorkflow({})]);
    await service.poll();
    await service.poll();
    expect(failed).toEqual(['workflow:remove-project-p1:r1']);
    expect(await service.shown('u1')).toHaveLength(1);
  });

  it('does not poll twice at once', async () => {
    const { service, closedSince } = await watching([]);
    let release: () => void = () => undefined;
    closedSince.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([]); }));
    const first = service.poll();
    expect(await service.poll()).toBe(0);
    release();
    await first;
    expect(closedSince).toHaveBeenCalledTimes(1);
  });
});

describe('a service with no clock of its own', () => {
  it('stamps a failure with the time it was seen', async () => {
    const { db } = await setUp();
    const service = new WorkFailureService({
      store: db.infrastructure,
      workflows: { closedSince: async () => [], failureOf: async () => undefined, describeRun: async () => undefined },
      records: async () => ({ trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined }),
      isPerson: async () => true,
    });
    const failure = await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    expect(Date.parse(failure?.failedAt ?? '')).toBeGreaterThan(Date.parse('2026-01-01'));
  });
});
