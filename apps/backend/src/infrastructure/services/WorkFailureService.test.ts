import { describe, expect, it } from 'vitest';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import { WorkFailureService, type FailedWorkflow } from './WorkFailureService.js';
import type { UserMetadata } from '../../platform/lib/types.js';

const NOW = new Date('2026-10-17T12:00:00Z');

async function setUp() {
  const db = memoryDatabase();
  await db.accounts.saveUser({ id: 'u1', email: 'u1@example.com', createdAt: 't', twoFactorEnabled: false, emailVerified: true } as UserMetadata);
  await db.accounts.saveUser({ id: 'space-1', email: 'space-1@koala.local', createdAt: 't', twoFactorEnabled: false, emailVerified: false, space: { person: 'u1', checkRunId: 'k1', scenarioId: 's1' } } as UserMetadata);
  let now = NOW;
  const service = new WorkFailureService({
    store: db.infrastructure,
    workflows: {
      describeRun: async (runId) => ({ workflowId: runId.split('~')[0]!, type: 'AgentRunWorkflow', startedAt: NOW.toISOString(), memo: { runId } }),
    },
    records: async () => ({ trees: [{ id: 't1', name: 'Shop' }], projects: [{ id: 'p1', name: 'Books' }], conversations: [{ id: 'c1', title: 'Labels' }], checkRuns: [], releases: [], agentName: (slug) => (slug === 'koala' ? 'Koala' : undefined) }),
    accounts: db.accounts,
    now: () => now,
  });
  return { db, service, later: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const failedWorkflow = (over: Partial<FailedWorkflow>): FailedWorkflow => ({
  workflowId: 'delete-project-p1', temporalRunId: 'r1', type: 'DeleteProjectWorkflow', startedAt: '2026-10-17T11:00:00Z',
  failedAt: '2026-10-17T11:30:00Z', ownerId: 'u1', message: 'Activity task failed', cause: 'delete-project-p1 could not reach its cluster', ...over,
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

  it('records a workflow that reports it failed, once, with its cause, but not deploys, children or platform work', async () => {
    const { service } = await setUp();
    for (const failed of [
      failedWorkflow({}),
      failedWorkflow({}),
      failedWorkflow({ workflowId: 'deploy-1', type: 'executeDeployAppWorkflow' }),
      failedWorkflow({ workflowId: 'sweep', type: 'SweepWorkflow', ownerId: 'platform' }),
      failedWorkflow({ workflowId: 'child', parent: 'delete-project-p1' }),
    ]) await service.workflowFailed(failed);
    expect(await service.shown('u1')).toEqual([expect.objectContaining({
      id: 'workflow:delete-project-p1:r1', kind: 'removal', title: 'Deleting the project Books', reason: 'delete-project-p1 could not reach its cluster', failedAt: '2026-10-17T11:30:00Z',
    })]);
  });

  it('says how it failed from its own message when it reports no cause', async () => {
    const { service } = await setUp();
    expect(await service.workflowFailed(failedWorkflow({ cause: undefined }))).toMatchObject({ reason: 'Activity task failed' });
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

  it('forgets failures after 30 days, when it next records one', async () => {
    const { service, db, later } = await setUp();
    await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    later(31 * 86_400_000);
    await service.runEnded({ ownerId: 'u1', runId: 'run-b', outcome: 'failed', depth: 0 });
    expect((await db.infrastructure.getWorkFailures('u1')).map((failure) => failure.id)).toEqual(['run:run-b']);
  });
});

describe('telling about failed work', () => {
  it('tells whoever listens about each failure it records, once', async () => {
    const { db } = await setUp();
    const failed: string[] = [];
    const service = new WorkFailureService({
      store: db.infrastructure,
      workflows: { describeRun: async () => undefined },
      records: async () => ({ trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined }),
      accounts: db.accounts,
      now: () => NOW,
      onFailure: (failure) => failed.push(failure.id),
    });
    await service.workflowFailed(failedWorkflow({}));
    await service.workflowFailed(failedWorkflow({}));
    expect(failed).toEqual(['workflow:delete-project-p1:r1']);
    expect(await service.shown('u1')).toHaveLength(1);
  });

  it('records nothing half-described when what it names cannot be read, and says why, so the report is made again', async () => {
    const { db } = await setUp();
    const failed: string[] = [];
    const service = new WorkFailureService({
      store: db.infrastructure,
      workflows: { describeRun: async () => undefined },
      records: async () => { throw new Error('records are down'); },
      accounts: db.accounts,
      now: () => NOW,
      onFailure: (failure) => failed.push(failure.id),
    });
    await expect(service.workflowFailed(failedWorkflow({}))).rejects.toThrow('records are down');
    await expect(service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 })).rejects.toThrow('records are down');
    expect(failed).toEqual([]);
    expect(await service.shown('u1')).toEqual([]);
  });
});

describe('a service with no clock of its own', () => {
  it('stamps a failure with the time it was seen', async () => {
    const { db } = await setUp();
    const service = new WorkFailureService({
      store: db.infrastructure,
      workflows: { describeRun: async () => undefined },
      records: async () => ({ trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined }),
      accounts: db.accounts,
    });
    const failure = await service.runEnded({ ownerId: 'u1', runId: 'run-a', outcome: 'failed', depth: 0 });
    expect(Date.parse(failure?.failedAt ?? '')).toBeGreaterThan(Date.parse('2026-01-01'));
  });
});
