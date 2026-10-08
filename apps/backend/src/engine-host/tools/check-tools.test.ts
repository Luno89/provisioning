import { describe, it, expect } from 'vitest';
import { createCheckTools, type CheckAccess, type CheckRunView } from './check-tools.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { ScenarioResult } from '../../eval/level2/results.js';

const scenario = (over: Partial<Scenario> & { id: string }, mine = false): Scenario & { mine: boolean } => ({
  name: over.id, describe: '', agent: 'executor', procedure: { id: 'do-one-task' }, input: { message: 'go' }, expect: { outcome: 'ok' }, mine, ...over,
});

const result = (scenarioId: string, passed: boolean): ScenarioResult => ({
  scenarioId, name: scenarioId, runId: `run-${scenarioId}`, procedure: { id: 'p', version: '1' }, passed, outcome: 'ok', answer: '',
  checks: [{ what: 'the run finished ok', passed, detail: passed ? 'it finished ok' : 'it failed' }],
  calls: [{ name: 'start_task', ok: true, digest: '' }], counters: { rounds: 1, toolCalls: 1, totalTokens: 1 }, tasks: [], durationMs: 1,
});

function world() {
  const saved: unknown[] = [];
  const started: unknown[] = [];
  const scenarios = [
    scenario({ id: 'executor-does-one-task', expect: { toolsCalled: ['start_task'] } }),
    scenario({ id: 'mine-writes', agent: 'research', step: { node: 'call-tool', settings: { tool: 'write_file' } }, procedure: { id: 'step-check-mine-writes' } }, true),
  ];
  const runs: CheckRunView[] = [
    { id: 'r1', state: 'done', scenarios: ['executor-does-one-task'], startedAt: '2026-10-07T10:00:00Z', results: [result('executor-does-one-task', false)] },
    { id: 'r2', state: 'running', scenarios: ['mine-writes'], startedAt: '2026-10-07T11:00:00Z', results: [] },
  ];
  const access: CheckAccess = {
    scenarios: async () => scenarios,
    runs: async () => runs,
    run: async (_owner, id) => runs.find((run) => run.id === id),
    save: async (_owner, check) => {
      saved.push(check);
      return (check as { name?: string }).name ? { saved: (check as { id: string }).id } : { problems: ['a check needs a name', 'it expects nothing'] };
    },
    remove: async (_owner, id) => scenarios.some((one) => one.id === id && one.mine),
    start: async (_owner, input) => { started.push(input); return { runId: 'r3' }; },
  };
  return { tools: createCheckTools(access, { waitMs: 0, pollMs: 1 }), saved, started, runs, access };
}

const call = (tools: ReturnType<typeof createCheckTools>, name: string, parsed: Record<string, unknown>) =>
  tools[name]!({ parsed, caller: { ownerId: 'bo', runId: 'run-1' } } as never);

describe('the check writer\'s tools', () => {
  it('lists the checks of one agent or tool, with level, model, whose it is and how it last went', async () => {
    const { tools } = world();
    expect((await call(tools, 'list_checks', { agent: 'executor' })).content).toBe('executor-does-one-task · run · their model · executor · built-in · last failed · executor-does-one-task');
    expect((await call(tools, 'list_checks', { tool: 'write_file' })).content).toBe('mine-writes · step · their model · research · theirs · never run · mine-writes');
    expect((await call(tools, 'list_checks', { agent: 'koala' })).content).toBe('no check covers that agent yet');
    expect(await call(tools, 'list_checks', { agent: 'a', tool: 'b' })).toMatchObject({ ok: false });
  });

  it('reads a check in full with its last result', async () => {
    const said = String((await call(tools(), 'read_check', { id: 'executor-does-one-task' })).content);
    expect(said).toContain('A built-in check executor-does-one-task');
    expect(said).toContain('"toolsCalled": [\n      "start_task"\n    ]');
    expect(said).toContain('✕ the run finished ok — it failed');
    expect(said).not.toContain('"mine"');
  });

  it('saves a new check, or lists every problem so all can be fixed, and never overwrites one', async () => {
    const { tools, saved } = world();
    expect((await call(tools, 'write_check', { check: { id: 'new-one', name: 'New one' } })).content).toContain('saved new-one');
    expect(await call(tools, 'write_check', { check: { id: 'new-two' } })).toMatchObject({ ok: false, content: 'nothing was saved — fix these and send the whole check again:\n- a check needs a name\n- it expects nothing' });
    expect(await call(tools, 'write_check', { check: { id: 'mine-writes', name: 'x' } })).toMatchObject({ ok: false, content: expect.stringContaining('change the person\'s own with update_check') });
    expect(await call(tools, 'write_check', { check: { id: 'executor-does-one-task', name: 'x' } })).toMatchObject({ ok: false, content: expect.stringContaining('built-in check called "executor-does-one-task"') });
    expect(saved).toHaveLength(2);
  });

  it('replaces only the person\'s own check, never a built-in', async () => {
    const { tools, saved } = world();
    expect((await call(tools, 'update_check', { check: { id: 'mine-writes', name: 'Changed' } })).content).toContain('replaced mine-writes');
    expect(await call(tools, 'update_check', { check: { id: 'executor-does-one-task', name: 'x' } })).toMatchObject({ ok: false, content: expect.stringContaining('it is built in') });
    expect(await call(tools, 'update_check', { check: { id: 'ghost', name: 'x' } })).toMatchObject({ ok: false });
    expect(saved).toHaveLength(1);
  });

  it('runs a check, and reads its result once it has finished', async () => {
    const { tools, started } = world();
    expect((await call(tools, 'run_check', { id: 'mine-writes', modelId: 'tabby' })).content).toContain('started run r3 of mine-writes with no model — it takes seconds');
    expect((await call(tools, 'run_check', { id: 'executor-does-one-task' })).content).toContain('on the person\'s model — it can take minutes');
    expect(started).toEqual([{ only: ['mine-writes'], modelId: 'tabby' }, { only: ['executor-does-one-task'] }]);
    expect((await call(tools, 'read_check_result', { runId: 'r2' })).content).toBe('still running after 0s (0 of 1 finished) — read it again to keep waiting');
    expect(String((await call(tools, 'read_check_result', { runId: 'r1' })).content)).toContain('executor-does-one-task: failed — run run-executor-does-one-task');
    expect(await call(tools, 'run_check', { id: 'ghost' })).toMatchObject({ ok: false });
  });

  it('deletes only the person\'s own checks', async () => {
    const { tools } = world();
    expect((await call(tools, 'delete_check', { id: 'mine-writes' })).content).toBe('deleted mine-writes');
    expect(await call(tools, 'delete_check', { id: 'executor-does-one-task' })).toMatchObject({ ok: false });
  });
});

function tools() {
  return world().tools;
}

describe('waiting for a check run', () => {
  it('waits for the run to finish before answering, rather than saying it is still running', async () => {
    const { runs, access } = world();
    const tools = createCheckTools(access, { waitMs: 1_000, pollMs: 5 });
    setTimeout(() => {
      runs[1]!.state = 'done';
      runs[1]!.results = [result('mine-writes', true)];
    }, 20);
    expect(String((await call(tools, 'read_check_result', { runId: 'r2' })).content)).toMatch(/^mine-writes: passed/);
  });
});
