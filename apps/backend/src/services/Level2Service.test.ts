import { describe, it, expect } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import { MemoryDB } from '../lib/memory-db.js';
import type { Scenario } from '../eval/level2/scenario.js';
import type { ScenarioResult } from '../eval/level2/results.js';
import type { CheckRunInput, CheckRunOutcome } from '../workflows/CheckRunWorkflow.js';
import { Level2Service, type CheckRunner, type Level2Run } from './Level2Service.js';
import { seededPersonas } from '../extensions/seeds.js';

const SCENARIO: Scenario = {
  id: 'builder-saves',
  name: 'The builder checks then saves',
  describe: 'It should compile before writing.',
  agent: 'agent-builder',
  procedure: { id: 'tool-rounds' },
  input: { message: 'Save this as tidy once it checks out.' },
  expect: { outcome: 'ok', toolsInOrder: ['check_procedure', 'save_procedure'], toolsNotCalled: ['list_tasks'] },
};

const result = (scenarioId: string, passed: boolean): ScenarioResult => ({
  scenarioId, name: scenarioId, runId: `run-of-${scenarioId}`, procedure: { id: 'tool-rounds', version: '3' }, passed, outcome: passed ? 'ok' : 'failed',
  answer: '', checks: [{ what: 'finishes ok', passed, detail: passed ? 'it finished ok' : 'it finished failed' }], calls: [], counters: { rounds: 1, toolCalls: 1, totalTokens: 10 }, tasks: [], durationMs: 5,
});

function fakeRunner() {
  const started: { workflowId: string; input: CheckRunInput }[] = [];
  const finishes = new Map<string, (outcome: CheckRunOutcome | { failed: string } | { missing: true }) => void>();
  const outcomes = new Map<string, Promise<CheckRunOutcome | { failed: string } | { missing: true }>>();
  const cancelled: string[] = [];
  const outcomeOf = (workflowId: string) => {
    if (!outcomes.has(workflowId)) outcomes.set(workflowId, new Promise((resolve) => finishes.set(workflowId, resolve)));
    return outcomes.get(workflowId)!;
  };
  const runner: CheckRunner = {
    start: async (workflowId, input) => { started.push({ workflowId, input }); outcomeOf(workflowId); },
    cancel: async (workflowId) => { cancelled.push(workflowId); return true; },
    outcome: (workflowId) => outcomeOf(workflowId),
  };
  const finish = (workflowId: string, outcome: CheckRunOutcome | { failed: string } | { missing: true }) => { outcomeOf(workflowId); finishes.get(workflowId)!(outcome); };
  return { runner, started, cancelled, finish };
}

function world(over: { builtIn?: Scenario[]; onFinished?: (run: Level2Run) => Promise<void>; runner?: CheckRunner } = {}) {
  const db = new MemoryDB();
  const fake = fakeRunner();
  let ids = 0;
  let ticks = 0;
  const service = new Level2Service({
    checks: over.runner ?? fake.runner,
    tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
    agents: async () => seededPersonas().map((agent) => agent.slug),
    procedures: async () => ['tool-rounds', 'research'],
    store: db,
    builtIn: over.builtIn ?? [SCENARIO],
    newId: () => `run-${(ids += 1)}`,
    now: () => new Date(Date.parse('2026-10-03T12:00:00Z') + (ticks += 1) * 1000).toISOString(),
    ...(over.onFinished ? { onFinished: over.onFinished } : {}),
    fingerprints: async (_ownerId, agents) => Object.fromEntries(agents.map((agent) => [agent, `${agent}-v1`])),
  });
  return { service, db, fake };
}

const settled = async (service: Level2Service, id: string): Promise<Level2Run> => {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = await service.get('user-1', id);
    if (run && run.state !== 'running') return run;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('the run never settled');
};

describe('Level 2 scenarios run as checks', () => {
  it('hands the chosen scenarios to the check runner, with the model, temperature, trial and only the tools a provocation or a turn needs', async () => {
    const provoking: Scenario = { ...SCENARIO, id: 'provokes', expect: { provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' } } };
    const choosing: Scenario = { ...SCENARIO, id: 'turn', procedure: { id: 'turn-check' }, turn: true, expect: { chooses: { tool: 'check_procedure' } } };
    const { service, fake } = world({ builtIn: [SCENARIO, provoking, choosing] });

    const run = await service.start({ ownerId: 'user-1', modelId: 'tabby', sampling: { toolTurn: { temperature: 0.2 }, conversation: { temperature: 0.2 } }, trialPractice: 'p1', promptOverride: { agent: 'koala', prompt: 'new' } }) as Level2Run;

    expect(run.state).toBe('running');
    expect(fake.started).toHaveLength(1);
    const { workflowId, input } = fake.started[0]!;
    expect(workflowId).toBe(`check-run-${run.id}`);
    expect(input).toMatchObject({ checkRunId: run.id, person: 'user-1', modelId: 'tabby', temperature: 0.2, trialPractice: 'p1', promptOverride: { agent: 'koala', prompt: 'new' } });
    expect(input.scenarios.map((scenario) => scenario.id)).toEqual(['builder-saves', 'provokes', 'turn']);
    expect(input.tools.map((tool) => tool.name).sort()).toEqual(['check_procedure', 'read_procedure']);
  });

  it('records the setup of every agent it checks, so two runs can be compared', async () => {
    const { service } = world({ builtIn: [SCENARIO, { ...SCENARIO, id: 'koala-one', agent: 'koala' }] });
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(run.agents).toEqual({ 'agent-builder': 'agent-builder-v1', koala: 'koala-v1' });
  });

  it('runs only the scenarios asked for, and refuses one that does not exist', async () => {
    const { service, fake } = world({ builtIn: [SCENARIO, { ...SCENARIO, id: 'other' }] });
    expect(await service.start({ ownerId: 'user-1', only: ['ghost'] })).toEqual({ unknown: ['ghost'] });
    await service.start({ ownerId: 'user-1', only: ['other'] });
    expect(fake.started[0]!.input.scenarios.map((scenario) => scenario.id)).toEqual(['other']);
  });

  it('settles the run with what the checks found, names a regression against the last full run, and reports it', async () => {
    const finished: Level2Run[] = [];
    const { service, fake } = world({ onFinished: async (run) => { finished.push(run); } });

    const first = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${first.id}`, { cancelled: false, results: [result('builder-saves', true)] });
    expect(await settled(service, first.id)).toMatchObject({ state: 'done', finished: 1, regressions: [] });

    const second = await service.start({ ownerId: 'user-1', trigger: { kind: 'full' } }) as Level2Run;
    fake.finish(`check-run-${second.id}`, { cancelled: false, results: [result('builder-saves', false)] });
    const done = await settled(service, second.id);
    expect(done).toMatchObject({ state: 'done', regressions: ['builder-saves'], trigger: { kind: 'full' } });
    expect(finished.map((run) => run.id)).toEqual([first.id, second.id]);
  });

  it('cancels through the runner, and settles as cancelled', async () => {
    const { service, fake } = world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;

    expect(await service.cancel('user-1', run.id)).toBe(true);
    expect(fake.cancelled).toEqual([`check-run-${run.id}`]);
    fake.finish(`check-run-${run.id}`, { cancelled: true, results: [] });
    expect(await settled(service, run.id)).toMatchObject({ state: 'cancelled' });
    expect(await service.cancel('user-1', run.id)).toBe(false);
  });

  it('says why the checks could not start, or why they ended badly', async () => {
    const failing: CheckRunner = { start: async () => { throw new Error('Temporal is not reachable'); }, cancel: async () => false, outcome: async () => ({ missing: true }) };
    const refused = await world({ runner: failing }).service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(refused).toMatchObject({ state: 'failed', error: 'the checks could not start: Temporal is not reachable' });

    const { service, fake } = world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${run.id}`, { failed: 'a step could not finish' });
    expect(await settled(service, run.id)).toMatchObject({ state: 'failed', error: 'a step could not finish' });
  });

  it('follows runs still going after the server restarts, rather than marking them interrupted', async () => {
    const { service, db, fake } = world();
    await db.saveEvalRecord('evalScenarioRuns', { id: 'old', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });

    expect(await service.recover()).toBe(1);
    fake.finish('check-run-old', { cancelled: false, results: [result('builder-saves', true)] });
    expect(await settled(service, 'old')).toMatchObject({ state: 'done', finished: 1 });
  });

  it('marks a run whose checks can no longer be found as interrupted', async () => {
    const { service, db, fake } = world();
    await db.saveEvalRecord('evalScenarioRuns', { id: 'lost', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });
    await service.recover();
    fake.finish('check-run-lost', { missing: true });
    expect(await settled(service, 'lost')).toMatchObject({ state: 'interrupted' });
  });
});

describe('Level 2 scenarios as data', () => {
  it('saves a scenario of your own and reports what is wrong with a bad one', async () => {
    const { service } = world();
    const mine: Scenario = { ...SCENARIO, id: 'mine', name: 'Mine' };

    expect(await service.saveScenario('user-1', mine)).toMatchObject({ saved: true });
    expect((await service.scenarios('user-1')).map((scenario) => [scenario.id, scenario.mine])).toEqual([['mine', true], ['builder-saves', false]]);
    expect((await service.scenarios('user-2')).map((scenario) => scenario.id)).toEqual(['builder-saves']);

    expect(await service.saveScenario('user-1', { ...SCENARIO, id: 'Bad Id', agent: 'ghost', procedure: { id: 'nope' }, expect: { toolsCalled: ['not_a_tool'] } })).toEqual({
      saved: false,
      problems: [
        'the id has to be lower-case words joined by dashes',
        'there is no agent called "ghost"',
        'there is no procedure called "nope"',
        'it expects not_a_tool, which is not a tool',
      ],
    });
    expect(await service.deleteScenario('user-1', 'mine')).toBe(true);
    expect(await service.deleteScenario('user-1', 'builder-saves')).toBe(false);
  });
});
