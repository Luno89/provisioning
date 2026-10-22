import { describe, it, expect } from 'vitest';
import { RunningService, type RunningDeps } from './RunningService.js';
import { DEFAULT_BENCH_SETTINGS, type BenchSettings } from '../../checks/lib/bench.js';
import type { RunningWorkflow } from '../lib/running.js';

function setUp(workflows: RunningWorkflow[] | undefined) {
  const done: string[] = [];
  let bench: BenchSettings = { ...DEFAULT_BENCH_SETTINGS };
  let keeper = { paused: false, held: 0 };
  const deps: RunningDeps = {
    workflows: {
      list: async () => workflows,
      waiting: async (id) => (id === 'run-r1' ? { asking: ['call-1'], waitsFor: [] } : { asking: [], waitsFor: id === 'release-p1' ? ['decide'] : [] }),
      cancel: async (id) => { done.push(`workflow ${id}`); return 'cancelled'; },
    },
    records: async () => ({ trees: [{ id: 't1', name: 'Shop' }], projects: [], conversations: [], checkRuns: [{ id: 'b1', trigger: { kind: 'changed' }, finished: 1, scenarios: [1, 2] }], releases: [], agentName: () => undefined }),
    checks: { cancel: async (_owner, id) => { done.push(`check ${id}`); return true; } },
    trees: { stop: async (_owner, id) => { done.push(`tree ${id}`); return { ok: true }; } },
    runs: { cancel: async (id) => { done.push(`run ${id}`); } },
    bench: { settings: async () => bench, saveSettings: async (_owner, value) => { bench = value as BenchSettings; return { saved: true }; } },
    keeper: { state: async () => keeper, setPaused: async (_owner, paused) => { keeper = { paused, held: paused ? 2 : 0 }; return keeper; } },
  };
  return { service: new RunningService(deps), done, bench: () => bench };
}

const at = '2026-10-16T15:00:00Z';

describe('what runs, for the person', () => {
  it('lists the person\'s running work with what each waits on, and the two switches', async () => {
    const { service } = setUp([
      { workflowId: 'check-run-b1', type: 'CheckRunWorkflow', startedAt: at },
      { workflowId: 'run-r1', type: 'AgentRunWorkflow', startedAt: at, memo: { runId: 'run-r1', agent: 'koala' } },
      { workflowId: 'release-p1', type: 'AgentRunWorkflow', startedAt: at, memo: { runId: 'release-p1~1' } },
    ]);
    const view = await service.view('u1');
    expect(view.ok && view.value.items.map((item) => [item.kind, item.asking, item.waitsFor])).toEqual([['bench', undefined, undefined], ['run', ['call-1'], undefined], ['release', undefined, ['decide']]]);
    expect(view.ok && view.value.bench).toEqual({ paused: false });
    expect(view.ok && view.value.keeper).toEqual({ paused: false, held: 0 });
  });

  it('says when Temporal cannot be read', async () => {
    expect(await setUp(undefined).service.view('u1')).toEqual({ ok: false, status: 503, error: 'Temporal is not reachable, so what runs cannot be read' });
  });

  it('cancels each kind of work its own way, refuses what cannot be stopped part way, and touches only the person\'s own', async () => {
    const { service, done } = setUp([
      { workflowId: 'check-run-b1', type: 'CheckRunWorkflow', startedAt: at },
      { workflowId: 'grove-run-t1', type: 'AgentRunWorkflow', startedAt: at },
      { workflowId: 'run-r1', type: 'AgentRunWorkflow', startedAt: at, memo: { runId: 'run-r1' } },
      { workflowId: 'pipeline-run-x', type: 'executePipelineRunWorkflow', startedAt: at },
      { workflowId: 'remove-project-p1', type: 'RemoveProjectWorkflow', startedAt: at },
    ]);
    for (const id of ['check-run-b1', 'grove-run-t1', 'run-r1', 'pipeline-run-x']) expect(await service.cancel('u1', id)).toEqual({ ok: true, value: { cancelling: true } });
    expect(done).toEqual(['check b1', 'tree t1', 'run run-r1', 'workflow pipeline-run-x']);
    expect(await service.cancel('u1', 'remove-project-p1')).toEqual({ ok: false, status: 409, error: 'Deleting the project cannot be cancelled: deleting cannot be stopped part way' });
    expect(await service.cancel('u1', 'someone-elses')).toEqual({ ok: false, status: 404, error: 'Nothing of yours is running under that id' });
  });

  it('pauses the bench through its own setting, and the memory keeper, and says what is held', async () => {
    const { service, bench } = setUp([]);
    expect(await service.pauseBench('u1', { paused: true })).toEqual({ ok: true, value: { paused: true } });
    expect(bench().enabled).toBe(false);
    expect(await service.pauseKeeper('u1', { paused: true })).toEqual({ ok: true, value: { paused: true, held: 2 } });
    expect(await service.pauseBench('u1', {})).toEqual({ ok: false, status: 400, error: 'say "paused": true or false' });
  });
});
