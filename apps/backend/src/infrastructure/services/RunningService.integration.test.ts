import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@temporalio/client';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { emptiedEachTime } from '../../platform/lib/test-database.js';
import type { MongoDB } from '../../platform/lib/mongo-db.js';
import { ownedQuery, startedFor } from '../../platform/lib/workflow-owner.js';
import { realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { BenchService } from '../../checks/services/BenchService.js';
import { MemoryKeeperService } from '../../memory/services/MemoryKeeperService.js';
import type { RunningWorkflow } from '../lib/running.js';
import { RunningService } from './RunningService.js';
import { TemporalBridge } from './TemporalBridge.js';
import { testDataDir } from '../../platform/testing/data-dir.js';

const fresh = await emptiedEachTime();

let env: TestWorkflowEnvironment;
let client: Client;

beforeAll(async () => {
  env = await realTemporalEnvironment();
  client = env.client;
});

afterAll(async () => {
  await env?.teardown();
});

const until = async <T>(look: () => Promise<T | undefined | false>): Promise<T> => {
  for (;;) {
    const found = await look();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const start = (owner: string, type: string, workflowId: string, memo: Record<string, unknown> = {}) =>
  client.workflow.start(type, { taskQueue: 'nobody-works-this-queue', workflowId, memo, ...startedFor(owner) });

const cancelRequested = async (workflowId: string): Promise<boolean> => {
  const history = await client.workflow.getHandle(workflowId).fetchHistory();
  return (history.events ?? []).some((event) => event.workflowExecutionCancelRequestedEventAttributes);
};

describe('what runs, for the person, against Temporal and the stored settings', () => {
  let db: MongoDB;
  let service: RunningService;
  let timers: Array<[string, number]>;
  const done: string[] = [];

  beforeEach(async () => {
    db = await fresh();
    timers = [];
    done.length = 0;
    const bridge = new TemporalBridge(db, testDataDir());
    Object.assign(bridge, { client });
    const bench = new BenchService({
      store: db,
      scenarios: async () => [],
      fingerprints: async () => ({}),
      start: async () => undefined,
      serving: async () => undefined,
      changes: { pending: async () => [], comparing: async () => undefined, settle: async () => undefined },
      earlier: async () => [],
      notifyChange: () => undefined,
      practices: { trials: async () => [], settle: async () => undefined },
      benchRunning: async () => false,
      agentsRunning: async () => false,
      idleTimer: async (ownerId, idleMs) => { timers.push([ownerId, idleMs]); },
      notify: () => undefined,
    });
    const keeper = new MemoryKeeperService({ store: db, start: vi.fn(), timer: vi.fn() as never, concludeAfterMinutes: async () => undefined });
    service = new RunningService({
      workflows: {
        list: async (ownerId) => {
          const found: RunningWorkflow[] = [];
          for await (const workflow of client.workflow.list({ query: `${ownedQuery(ownerId)} AND ExecutionStatus = "Running"` })) {
            found.push({ workflowId: workflow.workflowId, type: workflow.type, startedAt: workflow.startTime.toISOString(), ...(workflow.memo ? { memo: workflow.memo } : {}) });
          }
          return found;
        },
        waiting: async () => undefined,
        cancel: (workflowId) => bridge.cancelWorkflow(workflowId),
      },
      records: async () => ({ trees: [{ id: 't1', name: 'Shop' }, { id: 't2', name: 'Books' }], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined }),
      checks: { cancel: async (_owner, id) => { done.push(`check ${id}`); return true; } },
      trees: { stop: async (_owner, id) => { done.push(`tree ${id}`); return { ok: true }; } },
      runs: { cancel: async (id) => { done.push(`run ${id}`); } },
      bench,
      keeper,
    });
  });

  it('lists only the asking person\'s running workflows, with the two switches as stored', async () => {
    const owner = `u-${Math.random().toString(36).slice(2, 8)}`;
    await start(owner, 'AgentRunWorkflow', 'grove-run-t1');
    await start(owner, 'executePipelineRunWorkflow', `pipeline-run-${owner}`);
    await start(`${owner}-other`, 'executePipelineRunWorkflow', `pipeline-run-${owner}-other`);
    const view = await until(async () => {
      const seen = await service.view(owner);
      return seen.ok && seen.value.items.length === 2 ? seen.value : false;
    });
    expect(view.items.map((item) => item.workflowId).sort()).toEqual(['grove-run-t1', `pipeline-run-${owner}`]);
    expect(view.items.find((item) => item.workflowId === 'grove-run-t1')).toMatchObject({ kind: 'tree', title: 'Tree run: Shop' });
    expect(view.bench).toEqual({ paused: false });
    expect(view.keeper).toEqual({ paused: false, held: 0 });
  });

  it('cancels each kind of work its own way, and touches only the person\'s own', async () => {
    const owner = `u-${Math.random().toString(36).slice(2, 8)}`;
    await start(owner, 'executePipelineRunWorkflow', `pipeline-run-${owner}`);
    await start(owner, 'AgentRunWorkflow', `run-${owner}`, { runId: `run-${owner}` });
    await start(owner, 'AgentRunWorkflow', 'grove-run-t2');
    await start(owner, 'RemoveProjectWorkflow', `remove-project-${owner}`);
    await start(`${owner}-other`, 'executePipelineRunWorkflow', `pipeline-run-${owner}-other`);
    await until(async () => {
      const seen = await service.view(owner);
      return seen.ok && seen.value.items.length === 4;
    });

    expect(await service.cancel(owner, `pipeline-run-${owner}`)).toEqual({ ok: true, value: { cancelling: true } });
    expect(await cancelRequested(`pipeline-run-${owner}`)).toBe(true);
    expect(await service.cancel(owner, `run-${owner}`)).toEqual({ ok: true, value: { cancelling: true } });
    expect(await service.cancel(owner, 'grove-run-t2')).toEqual({ ok: true, value: { cancelling: true } });
    expect(done).toEqual([`run run-${owner}`, 'tree t2']);
    expect(await cancelRequested(`run-${owner}`)).toBe(false);
    expect(await service.cancel(owner, `remove-project-${owner}`)).toMatchObject({ ok: false, status: 409 });
    expect(await cancelRequested(`remove-project-${owner}`)).toBe(false);
    expect(await service.cancel(owner, `pipeline-run-${owner}-other`)).toEqual({ ok: false, status: 404, error: 'Nothing of yours is running under that id' });
    expect(await cancelRequested(`pipeline-run-${owner}-other`)).toBe(false);
  });

  it('pauses the bench and the memory keeper in the records that outlive a restart, and starts the idle timer again when the bench resumes', async () => {
    expect(await service.pauseBench('u1', { paused: true })).toEqual({ ok: true, value: { paused: true } });
    expect((await db.checks.getBenchSettings('u1'))?.enabled).toBe(false);
    expect(timers).toEqual([]);
    expect(await service.pauseBench('u1', { paused: false })).toEqual({ ok: true, value: { paused: false } });
    expect((await db.checks.getBenchSettings('u1'))?.enabled).toBe(true);
    expect(timers).toHaveLength(1);
    expect(await service.pauseKeeper('u1', { paused: true })).toEqual({ ok: true, value: { paused: true, held: 0, started: [] } });
    expect((await db.memory.getKeeperSettings('u1'))?.paused).toBe(true);
    expect(await service.pauseKeeper('u1', {})).toEqual({ ok: false, status: 400, error: 'say "paused": true or false' });
    const view = await service.view('u1');
    expect(view.ok && view.value.keeper).toEqual({ paused: true, held: 0 });
  });
});
