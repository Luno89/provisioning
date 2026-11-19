import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from 'vitest';
import axios from 'axios';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import { runningRouter } from './running.js';
import { mountRouter, TEST_USER, type Harness } from '../../platform/routes/test-harness.js';
import { ownedQuery, startedFor } from '../../platform/lib/workflow-owner.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { until } from '../../platform/testing/three-roles.js';
import { realTemporalEnvironment } from '../../workflows/testing/temporal-test-env.js';
import { BenchService } from '../../checks/services/BenchService.js';
import { MemoryKeeperService } from '../../memory/services/MemoryKeeperService.js';
import type { RunningWorkflow } from '../lib/running.js';
import { RunningService } from '../services/RunningService.js';
import { TemporalBridge } from '../services/TemporalBridge.js';
import { testDataDir } from '../../platform/testing/data-dir.js';

let env: TestWorkflowEnvironment;
beforeAll(async () => { env = await realTemporalEnvironment(); });
afterAll(async () => { await env?.teardown(); });

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

const quiet = { validateStatus: () => true };
const notThisWork = (what: string) => async (): Promise<never> => { throw new Error(`${what} is not what this route test cancels`); };

const runningOver = (db: Database): RunningService => {
  const bridge = new TemporalBridge(db, testDataDir());
  Object.assign(bridge, { client: env.client });
  return new RunningService({
    workflows: {
      list: async (ownerId) => {
        const found: RunningWorkflow[] = [];
        for await (const workflow of env.client.workflow.list({ query: `${ownedQuery(ownerId)} AND ExecutionStatus = "Running"` })) {
          found.push({ workflowId: workflow.workflowId, type: workflow.type, startedAt: workflow.startTime.toISOString(), ...(workflow.memo ? { memo: workflow.memo } : {}) });
        }
        return found;
      },
      waiting: async () => undefined,
      cancel: (workflowId) => bridge.cancelWorkflow(workflowId),
    },
    records: async () => ({ trees: [], projects: [], conversations: [], checkRuns: [], releases: [], agentName: () => undefined }),
    checks: { cancel: notThisWork('a check') },
    trees: { stop: notThisWork('a tree run') },
    runs: { cancel: notThisWork('an agent run') },
    bench: new BenchService({
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
      idleTimer: async () => undefined,
      notify: () => undefined,
    }),
    keeper: new MemoryKeeperService({ store: db, start: vi.fn(), timer: vi.fn() as never, concludeAfterMinutes: async () => undefined }),
  });
};

const cancelRequested = async (workflowId: string): Promise<boolean> => {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  return (history.events ?? []).some((event) => event.workflowExecutionCancelRequestedEventAttributes);
};

describe('/api/running', () => {
  it('shows, cancels and pauses as the signed-in person, and says why it cannot', async () => {
    h = await mountRouter({ prefix: '/api/running', router: (db) => runningRouter({ running: runningOver(db) }) });
    const stamp = Math.random().toString(36).slice(2, 8);
    const mine = `pipeline-run-${stamp}`;
    const theirs = `pipeline-run-${stamp}-other`;
    expect((await axios.get(h.url('/api/running'))).data).toEqual({ items: [], bench: { paused: false }, keeper: { paused: false, held: 0 } });
    await env.client.workflow.start('executePipelineRunWorkflow', { taskQueue: 'nobody-works-this-queue', workflowId: mine, ...startedFor(TEST_USER.id) });
    await env.client.workflow.start('executePipelineRunWorkflow', { taskQueue: 'nobody-works-this-queue', workflowId: theirs, ...startedFor('someone-else') });
    await until(async () => {
      const listed = (await axios.get(h!.url('/api/running'))).data as { items: { workflowId: string }[] };
      return listed.items.some((item) => item.workflowId === mine) ? true : undefined;
    });
    expect((await axios.post(h.url(`/api/running/${mine}/cancel`), {})).status).toBe(202);
    expect(await cancelRequested(mine)).toBe(true);
    expect((await axios.post(h.url('/api/running/gone/cancel'), {}, quiet)).data).toEqual({ error: 'Nothing of yours is running under that id' });
    expect((await axios.post(h.url(`/api/running/${theirs}/cancel`), {}, quiet)).data).toEqual({ error: 'Nothing of yours is running under that id' });
    expect(await cancelRequested(theirs)).toBe(false);
    await axios.put(h.url('/api/running/bench'), { paused: true });
    await axios.put(h.url('/api/running/keeper'), { paused: true });
    expect((await h.db.checks.getBenchSettings(TEST_USER.id))?.enabled).toBe(false);
    expect((await h.db.memory.getKeeperSettings(TEST_USER.id))?.paused).toBe(true);
    expect((await axios.get(h.url('/api/running'))).data).toMatchObject({ bench: { paused: true }, keeper: { paused: true, held: 0 } });
  });
});
