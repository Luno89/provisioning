import { describe, it, expect, vi } from 'vitest';
import { createGroveLauncher, RUN_END_POLL_MS, startOnceQuiet } from './grove-launcher.js';
import { EngineUnavailableError, type StartRunRequest } from './registries/run-starter.js';
import { workflowOfRun } from './temporal/contracts.js';

type Described = { status: { name: string }; startTime: Date; closeTime?: Date; memo?: Record<string, unknown> };

function fakeClient(runs: Record<string, { described: Described; result?: unknown; fails?: unknown }>) {
  const signalled: [string, string][] = [];
  return {
    signalled,
    client: {
      getHandle: (workflowId: string) => ({
        describe: async () => {
          const run = runs[workflowId];
          if (!run) throw new Error(`workflow ${workflowId} not found`);
          return run.described;
        },
        result: async () => {
          const run = runs[workflowId]!;
          if (run.fails) throw run.fails;
          return run.result;
        },
        signal: async (name: string) => { signalled.push([workflowId, name]); },
      }),
    } as never,
  };
}

const at = new Date('2026-10-01T10:00:00Z');

describe('the grove launcher', () => {
  it('starts the tree\'s grove agent under the tree\'s own run id, with the tree bound to it', async () => {
    const start = vi.fn(async () => ({ runId: 'grove-run-t1', agentSlug: 'grove-paper', loopId: 'grove-paper-run' }));
    const { client } = fakeClient({});
    const launcher = createGroveLauncher({ runs: { start }, client: () => client, agentFor: async () => 'grove-paper', leafRun: async () => undefined });

    expect(await launcher.startGroveRun('u1', 't1')).toEqual({ started: true, workflowId: 'grove-run-t1' });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'u1', agentSlug: 'grove-paper', runId: expect.stringMatching(/^grove-run-t1~[0-9a-z]+$/), bound: { treeId: 't1' } }));
  });

  it('starts the grove agent on the model the tree chose for it, and on its own when the tree chose none', async () => {
    const start = vi.fn(async (request: StartRunRequest) => ({ runId: request.runId!, agentSlug: 'grower', loopId: 'grow' }));
    const { client } = fakeClient({});
    const chosen: Record<string, { modelId?: string }> = { t1: { modelId: 'tabby' }, t2: {} };
    const launcher = createGroveLauncher({ runs: { start }, client: () => client, agentFor: async () => 'grower', leafRun: async () => undefined, modelFor: async (_owner, treeId, agent) => (agent === 'grower' ? chosen[treeId] : undefined) });
    await launcher.startGroveRun('u1', 't1');
    await launcher.startGroveRun('u1', 't2');
    expect(start.mock.calls.map(([request]) => request.modelId)).toEqual(['tabby', undefined]);
  });

  it('gives every run of a tree its own run id, under the one workflow that keeps it to one run at a time', async () => {
    const ids: string[] = [];
    const start = vi.fn(async (request: StartRunRequest) => { ids.push(request.runId!); return { runId: request.runId!, agentSlug: 'grove', loopId: 'grove-run' }; });
    const { client } = fakeClient({});
    const launcher = createGroveLauncher({ runs: { start }, client: () => client, agentFor: async () => 'grove', leafRun: async () => undefined });
    await launcher.startGroveRun('u1', 't1');
    await new Promise((resolve) => setTimeout(resolve, 2));
    await launcher.startGroveRun('u1', 't1');
    expect(new Set(ids).size).toBe(2);
    expect(ids.map(workflowOfRun)).toEqual(['grove-run-t1', 'grove-run-t1']);
  });

  it('says the tree is already running, or that the engine is not reachable', async () => {
    const { client } = fakeClient({});
    const running = createGroveLauncher({ runs: { start: async () => { throw new Error('Workflow execution already started'); } }, client: () => client, agentFor: async () => 'grove', leafRun: async () => undefined });
    const down = createGroveLauncher({ runs: { start: async () => { throw new EngineUnavailableError(); } }, client: () => client, agentFor: async () => 'grove', leafRun: async () => undefined });

    expect(await running.startGroveRun('u1', 't1')).toEqual({ started: false, reason: 'running' });
    expect(await down.startGroveRun('u1', 't1')).toEqual({ started: false, reason: 'unavailable' });
    expect(await createGroveLauncher({ runs: { start: vi.fn() }, client: () => undefined, agentFor: async () => 'grove', leafRun: async () => undefined }).startGroveRun('u1', 't1')).toEqual({ started: false, reason: 'unavailable' });
  });

  it('will not start a tree whose grove agent belongs to an extension the owner switched off', async () => {
    const start = vi.fn();
    const { client } = fakeClient({});
    const launcher = createGroveLauncher({ runs: { start }, client: () => client, agentFor: async () => 'grove', leafRun: async () => undefined, hidden: async () => ({ agents: new Set(['grove']) }) });

    expect(await launcher.startGroveRun('u1', 't1')).toEqual({ started: false, reason: 'switched-off' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reads the run\'s report as the tree\'s status, a stopped run as stopped, and a failed one with its reason', async () => {
    const report = { treeId: 't1', outcome: 'quiet', awaitingReview: ['a'], awaitingApproval: ['p1'] };
    const { client } = fakeClient({
      'grove-run-t1': { described: { status: { name: 'COMPLETED' }, startTime: at, closeTime: at }, result: { runId: 'r', agentId: 'grove', outcome: 'ok', outputs: report } },
      'grove-run-t2': { described: { status: { name: 'COMPLETED' }, startTime: at }, result: { runId: 'r', agentId: 'grove', outcome: 'interrupted', outputs: {} } },
      'grove-run-t3': { described: { status: { name: 'COMPLETED' }, startTime: at }, result: { runId: 'r', agentId: 'grove', outcome: 'failed', reason: 'a judge could not settle its claim', outputs: {} } },
      'grove-run-t4': { described: { status: { name: 'RUNNING' }, startTime: at, memo: { runId: 'grove-run-t4~k2' } } },
    });
    const launcher = createGroveLauncher({ runs: { start: vi.fn() }, client: () => client, agentFor: async () => 'grove', leafRun: async () => undefined });

    expect(await launcher.groveRunStatus('t1')).toMatchObject({ state: 'finished', result: report, turnId: 'grove-run-t1' });
    expect(await launcher.groveRunStatus('t2')).toMatchObject({ state: 'finished', result: { treeId: 't2', outcome: 'stopped' } });
    expect(await launcher.groveRunStatus('t3')).toMatchObject({ state: 'failed', reason: 'a judge could not settle its claim' });
    expect(await launcher.groveRunStatus('t4')).toMatchObject({ state: 'running', turnId: 'grove-run-t4~k2' });
    expect(await launcher.groveRunStatus('t9')).toEqual({ state: 'none' });
  });

  it('stops the tree\'s run, or one leaf\'s own run, and says when there is nothing running to stop', async () => {
    const { client, signalled } = fakeClient({
      'grove-run-t1': { described: { status: { name: 'RUNNING' }, startTime: at } },
      'grove-run-t1-grove-leaf-2': { described: { status: { name: 'RUNNING' }, startTime: at } },
      'grove-run-t2': { described: { status: { name: 'COMPLETED' }, startTime: at } },
    });
    const launcher = createGroveLauncher({ runs: { start: vi.fn() }, client: () => client, agentFor: async () => 'grove', leafRun: async (leafId) => (leafId === 'leafA' ? 'grove-run-t1-grove-leaf-2' : undefined) });

    expect(await launcher.signalGroveRun('t1', 'stopRun')).toBe(true);
    expect(await launcher.signalGroveRun('t1', 'cancelLeaf', 'leafA')).toBe(true);
    expect(await launcher.signalGroveRun('t2', 'stopRun')).toBe(false);
    expect(await launcher.signalGroveRun('t1', 'cancelLeaf', 'leafZ')).toBe(false);
    expect(signalled).toEqual([['grove-run-t1', 'cancelRun'], ['grove-run-t1-grove-leaf-2', 'cancelRun']]);
  });
});

describe('growing a tree whose run is still going', () => {
  it('waits for that run to end, then starts a fresh one that sees what was put back', async () => {
    const states = ['running', 'running', 'finished'];
    let starts = 0;
    const waited: number[] = [];
    const launcher = {
      startGroveRun: async () => (++starts === 1 ? { started: false as const, reason: 'running' as const } : { started: true as const, workflowId: 'grove-run-t1' }),
      groveRunStatus: async () => ({ state: states.shift() ?? 'finished' }) as never,
    };
    expect(await startOnceQuiet(launcher, 'u1', 't1', async (ms) => { waited.push(ms); })).toEqual({ started: true, workflowId: 'grove-run-t1' });
    expect([starts, waited]).toEqual([2, [RUN_END_POLL_MS, RUN_END_POLL_MS]]);
  });

  it('gives back any other reason it could not start', async () => {
    const launcher = { startGroveRun: async () => ({ started: false as const, reason: 'switched-off' as const }), groveRunStatus: async () => ({ state: 'none' }) as never };
    expect(await startOnceQuiet(launcher, 'u1', 't1', async () => undefined)).toEqual({ started: false, reason: 'switched-off' });
  });
});
