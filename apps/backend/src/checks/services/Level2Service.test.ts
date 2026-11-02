import type { Client } from '@temporalio/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../../engine-host/tools/engine-tool-seeds.js';
import type { ScenarioResult } from '../../eval/level2/results.js';
import type { Scenario } from '../../eval/level2/scenario.js';
import { seededPersonas } from '../../extensions/seeds.js';
import type { Database } from '../../platform/lib/db-interface.js';
import { memoryDatabase } from '../../platform/testing/memory-database.js';
import type { CheckRunInput, CheckRunOutcome } from '../../workflows/CheckRunWorkflow.js';
import type { ScenarioProposal } from '../lib/scenario-proposals.js';
import { Level2Service, checkRunWorkflowId, temporalCheckRunner, type CheckRunner, type Level2Run } from './Level2Service.js';

const SCENARIO: Scenario = {
  id: 'builder-saves',
  name: 'The builder checks then saves',
  describe: 'It should compile before writing.',
  agent: 'agent-builder',
  procedure: { id: 'tool-rounds' },
  input: { message: 'Save this as tidy once it checks out.' },
  expect: { outcome: 'ok', toolsInOrder: ['check_procedure', 'save_procedure'], toolsNotCalled: ['list_tasks'] },
};

type Outcome = CheckRunOutcome | { failed: string } | { missing: true };

const result = (scenarioId: string, passed: boolean): ScenarioResult => ({
  scenarioId, name: scenarioId, runId: `run-of-${scenarioId}`, procedure: { id: 'tool-rounds', version: '3' }, passed, outcome: passed ? 'ok' : 'failed',
  answer: '', checks: [{ what: 'finishes ok', passed, detail: passed ? 'it finished ok' : 'it finished failed' }], calls: [], counters: { rounds: 1, toolCalls: 1, totalTokens: 10 }, tasks: [], durationMs: 5,
});

function fakeRunner() {
  const started: { workflowId: string; input: CheckRunInput }[] = [];
  const finishes = new Map<string, (outcome: Outcome) => void>();
  const outcomes = new Map<string, Promise<Outcome>>();
  const cancelled: string[] = [];
  const outcomeOf = (workflowId: string) => {
    if (!outcomes.has(workflowId)) outcomes.set(workflowId, new Promise((resolve) => finishes.set(workflowId, resolve)));
    return outcomes.get(workflowId)!;
  };
  const runner = mock<CheckRunner>();
  runner.start.mockImplementation(async (workflowId, input) => {
    started.push({ workflowId, input });
    void outcomeOf(workflowId);
  });
  runner.cancel.mockImplementation(async (workflowId) => {
    cancelled.push(workflowId);
    return true;
  });
  runner.outcome.mockImplementation((workflowId) => outcomeOf(workflowId));
  const finish = (workflowId: string, outcome: Outcome) => {
    void outcomeOf(workflowId);
    finishes.get(workflowId)!(outcome);
  };
  return { runner, started, cancelled, finish };
}

function world(over: { builtIn?: Scenario[]; onFinished?: (run: Level2Run) => Promise<void>; runner?: CheckRunner; fingerprints?: (ownerId: string, agents: readonly string[]) => Promise<Record<string, string>> } = {}) {
  const db: Database = memoryDatabase();
  const fake = fakeRunner();
  let ids = 0;
  let ticks = 0;
  const service = new Level2Service({
    checks: over.runner ?? fake.runner,
    tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
    agents: async () => seededPersonas().map((agent) => agent.slug),
    procedures: async () => ['tool-rounds', 'research'],
    store: db.checks,
    builtIn: over.builtIn ?? [SCENARIO],
    newId: () => `run-${(ids += 1)}`,
    now: () => new Date(Date.parse('2026-10-03T12:00:00Z') + (ticks += 1) * 1000).toISOString(),
    ...(over.onFinished ? { onFinished: over.onFinished } : {}),
    fingerprints: over.fingerprints ?? (async (_ownerId, agents) => Object.fromEntries(agents.map((agent) => [agent, `${agent}-v1`]))),
  });
  return { service, db, fake };
}

const settled = async (service: Level2Service, id: string): Promise<Level2Run> => {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = await service.get('user-1', id);
    if (run && run.state !== 'running') return run;
    await new Promise((done) => setTimeout(done, 1));
  }
  throw new Error('the run never settled');
};

describe('Level 2 scenarios run as checks', () => {
  it('hands the chosen scenarios to the check runner, with the model, temperature, trial and only the tools a provocation or a turn needs', async () => {
    const provoking: Scenario = { ...SCENARIO, id: 'provokes', expect: { provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' } } };
    const choosing: Scenario = { ...SCENARIO, id: 'turn', procedure: { id: 'turn-check' }, turn: true, expect: { chooses: { tool: 'check_procedure' } } };
    const { service, fake } = world({ builtIn: [SCENARIO, provoking, choosing] });

    const run = await service.start({ ownerId: 'user-1', modelId: 'tabby', modelLabel: 'Tabby', sampling: { toolTurn: { temperature: 0.2 }, conversation: { temperature: 0.2 } }, trialPractice: 'p1', promptOverride: { agent: 'koala', prompt: 'new' } }) as Level2Run;

    expect(run.state).toBe('running');
    expect(run).toMatchObject({ modelLabel: 'Tabby', trigger: { kind: 'manual' } });
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

  it('still starts when the agents\' fingerprints cannot be read, saying so', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service } = world({ fingerprints: async () => { throw new Error('no agents'); } });
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(run.state).toBe('running');
    expect(run.agents).toBeUndefined();
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('no agents'));
    warned.mockRestore();
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
    expect((await service.list('user-1')).map((run) => run.id).sort()).toEqual([first.id, second.id]);
  });

  it('does not count runs of a practice, a tool note or a prompt change as the last full run', async () => {
    const { service, fake } = world();
    const trial = await service.start({ ownerId: 'user-1', trigger: { kind: 'practice', agent: 'koala', practiceId: 'p1' } }) as Level2Run;
    fake.finish(`check-run-${trial.id}`, { cancelled: false, results: [result('builder-saves', true)] });
    await settled(service, trial.id);
    const next = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${next.id}`, { cancelled: false, results: [result('builder-saves', false)] });
    expect(await settled(service, next.id)).toMatchObject({ regressions: [] });
    expect((await service.earlier(next)).map((run) => run.id)).toEqual([]);
  });

  it('cancels through the runner, and settles as cancelled', async () => {
    const { service, fake } = world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;

    expect(await service.cancel('user-1', run.id)).toBe(true);
    expect(fake.cancelled).toEqual([`check-run-${run.id}`]);
    fake.finish(`check-run-${run.id}`, { cancelled: true, results: [] });
    expect(await settled(service, run.id)).toMatchObject({ state: 'cancelled' });
    expect(await service.cancel('user-1', run.id)).toBe(false);
    expect(await service.cancel('user-1', 'nope')).toBe(false);
  });

  it('says why the checks could not start, or why they ended badly', async () => {
    const failing = mock<CheckRunner>();
    failing.start.mockRejectedValue(new Error('Temporal is not reachable'));
    const refused = await world({ runner: failing }).service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(refused).toMatchObject({ state: 'failed', error: 'the checks could not start: Temporal is not reachable' });

    const { service, fake } = world();
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${run.id}`, { failed: 'a step could not finish' });
    expect(await settled(service, run.id)).toMatchObject({ state: 'failed', error: 'a step could not finish' });
  });

  it('settles as failed when the runner itself breaks while following the checks', async () => {
    const broken = mock<CheckRunner>();
    broken.start.mockResolvedValue(undefined);
    broken.outcome.mockRejectedValue(new Error('the connection dropped'));
    const { service } = world({ runner: broken });
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    expect(await settled(service, run.id)).toMatchObject({ state: 'failed', error: 'the connection dropped' });
  });

  it('keeps the run settled even when what follows from it fails, saying so', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { service, fake } = world({ onFinished: async () => { throw new Error('the trial could not be settled'); } });
    const run = await service.start({ ownerId: 'user-1' }) as Level2Run;
    fake.finish(`check-run-${run.id}`, { cancelled: false, results: [] });
    expect(await settled(service, run.id)).toMatchObject({ state: 'done' });
    await vi.waitFor(() => expect(warned).toHaveBeenCalledWith(expect.stringContaining('the trial could not be settled')));
    warned.mockRestore();
  });

  it('follows runs still going after the server restarts, rather than marking them interrupted', async () => {
    const { service, db, fake } = world();
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'old', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });

    expect(await service.recover()).toBe(1);
    fake.finish('check-run-old', { cancelled: false, results: [result('builder-saves', true)] });
    expect(await settled(service, 'old')).toMatchObject({ state: 'done', finished: 1 });
  });

  it('marks a run whose checks can no longer be found as interrupted', async () => {
    const { service, db, fake } = world();
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'lost', ownerId: 'user-1', state: 'running', startedAt: '2026-10-03T00:00:00Z', scenarios: ['builder-saves'], finished: 0, results: [] });
    await service.recover();
    fake.finish('check-run-lost', { missing: true });
    expect(await settled(service, 'lost')).toMatchObject({ state: 'interrupted' });
  });

  it('compares two runs by what differs between them, and has nothing to say about a run that is not there', async () => {
    const { service, db } = world();
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'a', ownerId: 'user-1', state: 'done', startedAt: '1', scenarios: ['builder-saves'], finished: 1, results: [result('builder-saves', true)], modelLabel: 'one' });
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'b', ownerId: 'user-1', state: 'done', startedAt: '2', scenarios: ['builder-saves'], finished: 1, results: [result('builder-saves', false)], modelLabel: 'two' });
    const comparison = await service.compare('user-1', 'a', 'b');
    expect(comparison).toMatchObject({ before: 'a', after: 'b', differences: [{ what: 'model', before: 'one', after: 'two' }] });
    expect(await service.compare('user-1', 'a', 'ghost')).toBeUndefined();
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

  it('shows a scenario of your own in place of a built-in one with the same id', async () => {
    const { service } = world();
    await service.saveScenario('user-1', { ...SCENARIO, name: 'My version' });
    expect((await service.scenarios('user-1')).map((scenario) => [scenario.name, scenario.mine])).toEqual([['My version', true]]);
  });

  it('lists the tools no check covers', async () => {
    const { service } = world();
    const gaps = await service.coverage('user-1');
    expect(gaps.some((gap) => gap.kind === 'uncovered' && gap.tool === 'app_drift')).toBe(true);
    expect(gaps.some((gap) => gap.kind === 'uncovered' && gap.tool === 'check_procedure')).toBe(false);
  });

  it('gives the procedure a step check or a turn check runs, and none for a check of a whole run', async () => {
    const turn: Scenario = { ...SCENARIO, id: 'a-turn', turn: true, procedure: { id: 'turn-check' }, expect: { chooses: { tool: 'check_procedure' } } };
    const step: Scenario = { ...SCENARIO, id: 'a-step', step: { node: 'text', settings: { text: 'hello' } } };
    const broken: Scenario = { ...SCENARIO, id: 'a-bad-step', step: { node: 'teleport' } };
    const { service } = world({ builtIn: [SCENARIO, turn, step, broken] });
    expect((await service.checkProcedure('user-1', 'a-turn'))?.id).toBe('turn-check');
    expect((await service.checkProcedure('user-1', 'a-step'))?.id).toBe('step-check-a-step');
    expect(await service.checkProcedure('user-1', 'a-bad-step')).toBeUndefined();
    expect(await service.checkProcedure('user-1', 'builder-saves')).toBeUndefined();
    expect(await service.checkProcedure('user-1', 'ghost')).toBeUndefined();
  });

  it('shows the compare of two turn checks by the tool each should choose', async () => {
    const turn: Scenario = { ...SCENARIO, id: 'a-turn', turn: true, procedure: { id: 'turn-check' }, expect: { chooses: { tool: 'check_procedure' } } };
    const { service, db } = world({ builtIn: [turn] });
    const turnResult = (passed: boolean): ScenarioResult => ({ ...result('a-turn', passed), turn: { toolCalls: [{ name: passed ? 'check_procedure' : 'other_tool', arguments: '{}' }], content: '' } } as ScenarioResult);
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'a', ownerId: 'user-1', state: 'done', startedAt: '1', scenarios: ['a-turn'], finished: 1, results: [turnResult(true)] });
    await db.checks.saveEvalRecord('evalScenarioRuns', { id: 'b', ownerId: 'user-1', state: 'done', startedAt: '2', scenarios: ['a-turn'], finished: 1, results: [turnResult(false)] });
    expect(await service.compare('user-1', 'a', 'b')).toMatchObject({ before: 'a', after: 'b' });
  });
});

describe('scenarios Koala proposed', () => {
  const proposal = (id: string, over: Partial<ScenarioProposal> = {}): ScenarioProposal => ({
    id, ownerId: 'user-1', scenario: { ...SCENARIO, id: `from-${id}` }, why: 'it misbehaved', status: 'proposed', createdAt: id, ...over,
  });

  it('lists proposals newest first', async () => {
    const { service, db } = world();
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('1'));
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('2'));
    expect((await service.proposals('user-1')).map((entry) => entry.id)).toEqual(['2', '1']);
  });

  it('saves an accepted proposal as the person\'s own check, as edited or as proposed, and marks it accepted', async () => {
    const { service, db } = world();
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('1'));
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('2'));
    expect(await service.acceptProposal('user-1', '1')).toMatchObject({ saved: true, scenario: { id: 'from-1' } });
    expect(await service.acceptProposal('user-1', '2', { ...SCENARIO, id: 'edited' })).toMatchObject({ saved: true, scenario: { id: 'edited' } });
    expect((await db.checks.getEvalRecord<ScenarioProposal>('evalScenarioProposals', 'user-1', '1'))?.status).toBe('accepted');
    expect(await service.acceptProposal('user-1', '1')).toEqual({ missing: true });
    expect(await service.acceptProposal('user-1', 'ghost')).toEqual({ missing: true });
  });

  it('leaves a proposal waiting when the edited scenario is not valid', async () => {
    const { service, db } = world();
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('1'));
    expect(await service.acceptProposal('user-1', '1', { ...SCENARIO, id: 'Bad Id' })).toMatchObject({ saved: false });
    expect((await db.checks.getEvalRecord<ScenarioProposal>('evalScenarioProposals', 'user-1', '1'))?.status).toBe('proposed');
  });

  it('dismisses a proposal that is waiting, once', async () => {
    const { service, db } = world();
    await db.checks.saveEvalRecord('evalScenarioProposals', proposal('1'));
    expect(await service.dismissProposal('user-1', '1')).toBe(true);
    expect(await service.dismissProposal('user-1', '1')).toBe(false);
    expect(await service.dismissProposal('user-1', 'ghost')).toBe(false);
    expect((await db.checks.getEvalRecord<ScenarioProposal>('evalScenarioProposals', 'user-1', '1'))?.status).toBe('dismissed');
  });
});

describe('the check runner on Temporal', () => {
  type Workflow = Client['workflow'];
  let workflow: ReturnType<typeof mock<Workflow>>;
  let handle: ReturnType<typeof mock<ReturnType<Workflow['getHandle']>>>;

  const runner = (connected: Client | null | undefined = mock<Client>({ workflow })) => temporalCheckRunner(() => connected, 'engine-queue');

  beforeEach(() => {
    workflow = mock<Workflow>();
    handle = mock<ReturnType<Workflow['getHandle']>>();
    workflow.getHandle.mockReturnValue(handle as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the check run workflow on its queue, owned by the person it is for', async () => {
    workflow.start.mockResolvedValue(undefined as never);
    const input = { checkRunId: 'run-1', person: 'user-1', scenarios: [], tools: [] } as CheckRunInput;
    await runner().start('check-run-run-1', input);
    expect(workflow.start).toHaveBeenCalledWith(expect.anything() as never, expect.objectContaining({ workflowId: 'check-run-run-1', taskQueue: 'engine-queue', args: [input] }) as never);
  });

  it('refuses when Temporal is not there', async () => {
    await expect(runner(null).start('w', { person: 'user-1' } as CheckRunInput)).rejects.toThrow('Temporal is not reachable');
  });

  it('cancels by signal, says nothing was there to cancel when the workflow is not found, and passes on any other failure', async () => {
    handle.signal.mockResolvedValueOnce(undefined as never);
    expect(await runner().cancel('w')).toBe(true);
    expect(handle.signal).toHaveBeenCalledWith('cancelCheck');
    handle.signal.mockRejectedValueOnce(new Error('workflow not found for id w'));
    expect(await runner().cancel('w')).toBe(false);
    handle.signal.mockRejectedValueOnce(new Error('the server fell over'));
    await expect(runner().cancel('w')).rejects.toThrow('the server fell over');
  });

  it('reads the outcome of a workflow, and says whether it is missing or failed', async () => {
    const outcome: CheckRunOutcome = { cancelled: false, results: [] };
    handle.result.mockResolvedValueOnce(outcome as never);
    expect(await runner().outcome('w')).toEqual(outcome);
    handle.result.mockRejectedValueOnce(new Error('workflow not found'));
    expect(await runner().outcome('w')).toEqual({ missing: true });
    handle.result.mockRejectedValueOnce(Object.assign(new Error('workflow execution failed'), { cause: new Error('the model went away') }));
    expect(await runner().outcome('w')).toEqual({ failed: 'the model went away' });
    handle.result.mockRejectedValueOnce({});
    expect(await runner().outcome('w')).toEqual({ failed: 'the checks failed' });
  });

  it('names a workflow after its check run', () => {
    expect(checkRunWorkflowId('abc')).toBe('check-run-abc');
  });
});
