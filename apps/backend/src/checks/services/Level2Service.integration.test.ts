import { describe, it, expect } from 'vitest';
import { BUILDER_SAVES, level2Options, scenarioResult } from '../testing/level2-options.js';
import { testDatabase } from '../../platform/lib/test-database.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import type { CheckRunInput, CheckRunOutcome } from '../../workflows/CheckRunWorkflow.js';
import { Level2Service, type CheckRunner, type Level2Run } from './Level2Service.js';

const SCENARIO = BUILDER_SAVES;

const result = scenarioResult;

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
    start: async (workflowId, input) => { started.push({ workflowId, input }); void outcomeOf(workflowId); },
    cancel: async (workflowId) => { cancelled.push(workflowId); return true; },
    outcome: (workflowId) => outcomeOf(workflowId),
  };
  const finish = (workflowId: string, outcome: CheckRunOutcome | { failed: string } | { missing: true }) => { void outcomeOf(workflowId); finishes.get(workflowId)!(outcome); };
  return { runner, started, cancelled, finish };
}

async function world(over: { builtIn?: Scenario[]; onFinished?: (run: Level2Run) => Promise<void>; runner?: CheckRunner } = {}) {
  const db = await testDatabase();
  const fake = fakeRunner();
  const finishing = new Map<string, (run: Level2Run) => void>();
  const finishings = new Map<string, Promise<Level2Run>>();
  const finishingOf = (id: string): Promise<Level2Run> => {
    if (!finishings.has(id)) finishings.set(id, new Promise((done) => finishing.set(id, done)));
    return finishings.get(id)!;
  };
  const service = new Level2Service({
    ...level2Options(db, over.runner ?? fake.runner, over.builtIn ?? [SCENARIO]),
    onFinished: async (run) => {
      await over.onFinished?.(run);
      void finishingOf(run.id);
      finishing.get(run.id)!(run);
    },
    fingerprints: async (_ownerId, agents) => Object.fromEntries(agents.map((agent) => [agent, `${agent}-v1`])),
  });
  return { service, db, fake, settled: finishingOf };
}

describe('Level 2 scenarios run as checks', () => {
  it('hands the chosen scenarios to the check runner, with the model, temperature, trial and only the tools a provocation or a turn needs', async () => {
    const provoking: Scenario = { ...SCENARIO, id: 'provokes', expect: { provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' } } };
    const choosing: Scenario = { ...SCENARIO, id: 'turn', procedure: { id: 'turn-check' }, turn: true, expect: { chooses: { tool: 'check_procedure' } } };
    const { service, fake } = await world({ builtIn: [SCENARIO, provoking, choosing] });

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
    const { service } = await world({ builtIn: [SCENARIO, { ...SCENARIO, id: 'koala-one', agent: 'koala' }] });
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(run.agents).toEqual({ 'agent-builder': 'agent-builder-v1', koala: 'koala-v1' });
  });

  it('runs only the scenarios asked for, and refuses one that does not exist', async () => {
    const { service, fake } = await world({ builtIn: [SCENARIO, { ...SCENARIO, id: 'other' }] });
    expect(await service.start({ ownerId: 'user-1', only: ['ghost'] })).toEqual({ unknown: ['ghost'] });
    await service.start({ ownerId: 'user-1', only: ['other'] });
    expect(fake.started[0]!.input.scenarios.map((scenario) => scenario.id)).toEqual(['other']);
  });

  it('settles the run with what the checks found, names a regression against the last full run, and reports it', async () => {
    const finished: Level2Run[] = [];
    const { service, fake, settled } = await world({ onFinished: async (run) => { finished.push(run); } });

    const first = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${first.id}`, { cancelled: false, results: [result('builder-saves', true)] });
    expect(await settled(first.id)).toMatchObject({ state: 'done', finished: 1, regressions: [] });

    const second = await service.start({ ownerId: 'user-1', trigger: { kind: 'full' } }) as Level2Run;
    fake.finish(`check-run-${second.id}`, { cancelled: false, results: [result('builder-saves', false)] });
    const done = await settled(second.id);
    expect(done).toMatchObject({ state: 'done', regressions: ['builder-saves'], trigger: { kind: 'full' } });
    expect(finished.map((run) => run.id)).toEqual([first.id, second.id]);
    expect((await service.list('user-1')).map((run) => run.id).sort()).toEqual([first.id, second.id]);
    expect(await service.list('someone-else')).toEqual([]);
  });

  it('cancels through the runner, and settles as cancelled', async () => {
    const { service, fake, settled } = await world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;

    expect(await service.cancel('user-1', run.id)).toBe(true);
    expect(fake.cancelled).toEqual([`check-run-${run.id}`]);
    fake.finish(`check-run-${run.id}`, { cancelled: true, results: [] });
    expect(await settled(run.id)).toMatchObject({ state: 'cancelled' });
    expect(await service.cancel('user-1', run.id)).toBe(false);
  });

  it('says why the checks could not start, or why they ended badly', async () => {
    const failing: CheckRunner = { start: async () => { throw new Error('Temporal is not reachable'); }, cancel: async () => false, outcome: async () => ({ missing: true }) };
    const refused = await (await world({ runner: failing })).service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(refused).toMatchObject({ state: 'failed', error: 'the checks could not start: Temporal is not reachable' });

    const { service, fake, settled } = await world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${run.id}`, { failed: 'a step could not finish' });
    expect(await settled(run.id)).toMatchObject({ state: 'failed', error: 'a step could not finish' });
  });

  it('follows runs still going after the server restarts, rather than marking them interrupted', async () => {
    const { service, db, fake, settled } = await world();
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'old', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });

    expect(await service.recover()).toBe(1);
    fake.finish('check-run-old', { cancelled: false, results: [result('builder-saves', true)] });
    expect(await settled('old')).toMatchObject({ state: 'done', finished: 1 });
  });

  it('marks a run whose checks can no longer be found as interrupted', async () => {
    const { service, db, fake, settled } = await world();
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'lost', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });
    await service.recover();
    fake.finish('check-run-lost', { missing: true });
    expect(await settled('lost')).toMatchObject({ state: 'interrupted' });
  });
});

describe('Level 2 scenarios as data', () => {
  it('saves a scenario of your own and reports what is wrong with a bad one', async () => {
    const { service } = await world();
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
