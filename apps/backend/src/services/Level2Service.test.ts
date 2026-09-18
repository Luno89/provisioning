import { describe, it, expect, vi, afterEach } from 'vitest';
import { ALL_SEEDED_AGENTS, BUILDER_TOOLS, type ModelProvider } from '@koala/agent-engine';
import { ENGINE_TOOL_SEEDS } from '../engine-host/tools/engine-tool-seeds.js';
import { EXAMPLE_PROCEDURE } from '@koala/agent-engine/procedure';
import { MemoryDB } from '../lib/memory-db.js';
import type { StoredNodeTrace } from '../lib/run-traces.js';
import type { Scenario } from '../eval/level2/scenario.js';
import { Level2Service, type Level2Run } from './Level2Service.js';

const PROVIDER = { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as ModelProvider;

type Frame = Record<string, unknown>;
const answer = (content: string): Frame[] => [{ choices: [{ delta: { content }, finish_reason: 'stop' }] }];
const calls = (...made: { name: string; args: Record<string, unknown> }[]): Frame[] => [
  ...made.map((call, index) => ({ choices: [{ delta: { tool_calls: [{ index, id: `c${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })),
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

function stubModel(...turns: Frame[][]) {
  let turn = 0;
  const fetchImpl = vi.fn(async () => {
    const frames = turns[Math.min(turn, turns.length - 1)]!;
    turn += 1;
    return {
      ok: true, status: 200, headers: new Headers(), text: async () => '',
      body: (async function* () {
        for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n`;
        yield 'data: [DONE]\n';
      })(),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

const SCENARIO: Scenario = {
  id: 'builder-saves',
  name: 'The builder checks then saves',
  describe: 'It should compile before writing.',
  agent: 'agent-builder',
  procedure: { id: 'tool-rounds' },
  input: { message: 'Save this as tidy once it checks out.' },
  expect: { outcome: 'ok', toolsInOrder: ['check_procedure', 'save_procedure'], toolsNotCalled: ['list_tasks'] },
};

const TIDY = JSON.stringify({ ...EXAMPLE_PROCEDURE, id: 'tidy', name: 'Tidy' });

function world(over: { builtIn?: Scenario[] } = {}) {
  const db = new MemoryDB();
  const traces: StoredNodeTrace[] = [];
  let ids = 0;
  const service = new Level2Service({
    world: {
      models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
      personas: async () => [...ALL_SEEDED_AGENTS()],
      tools: async () => [],
      procedures: async () => [],
    },
    tools: async () => [...BUILDER_TOOLS, ...ENGINE_TOOL_SEEDS],
    agents: async () => ALL_SEEDED_AGENTS().map((agent) => agent.slug),
    procedures: async () => ['tool-rounds', 'research'],
    store: db,
    traces: async (batch) => { traces.push(...batch); },
    builtIn: over.builtIn ?? [SCENARIO],
    newId: () => `run-${(ids += 1)}`,
  });
  return { service, db, traces };
}

const settled = async (service: Level2Service, id: string): Promise<Level2Run> => {
  for (let tries = 0; tries < 400; tries += 1) {
    const run = await service.get('user-1', id);
    if (run && run.state !== 'running') return run;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('the run never finished');
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('Level 2 scenarios', () => {
  it('runs the real procedure with real tool handlers and scores what happened', async () => {
    stubModel(
      calls({ name: 'check_procedure', args: { source: TIDY } }),
      calls({ name: 'save_procedure', args: { source: TIDY } }),
      answer('Saved it as tidy.'),
    );
    const { service, traces } = world();

    const run = await settled(service, ((await service.start({ ownerId: 'user-1' })) as Level2Run).id);
    const [result] = run.results;

    expect(run.state).toBe('done');
    expect(result).toMatchObject({ scenarioId: 'builder-saves', passed: true, outcome: 'ok', answer: 'Saved it as tidy.' });
    expect(result!.checks).toEqual([
      { what: 'finishes ok', passed: true, detail: 'it finished ok' },
      { what: 'never calls list_tasks', passed: true, detail: 'it did not call list_tasks' },
      { what: 'calls check_procedure then save_procedure', passed: true, detail: 'it called them in that order' },
    ]);
    expect(result!.calls.map((call) => [call.name, call.ok])).toEqual([['check_procedure', true], ['save_procedure', true]]);
    expect(traces.filter((trace) => trace.runId === result!.runId).map((trace) => trace.kind)).toEqual(expect.arrayContaining(['call-model', 'run-tool-calls', 'finish']));
  }, 30_000);

  it('keeps what the run wrote inside the scenario, never in the real store', async () => {
    stubModel(calls({ name: 'save_procedure', args: { source: TIDY } }), answer('Saved.'));
    const { service, db } = world();

    await settled(service, ((await service.start({ ownerId: 'user-1' })) as Level2Run).id);

    expect(await db.getProcedures('user-1')).toEqual([]);
  }, 30_000);

  it('says which expectations did not hold', async () => {
    stubModel(answer('I would rather not.'));
    const { service } = world();

    const run = await settled(service, ((await service.start({ ownerId: 'user-1' })) as Level2Run).id);

    expect(run.results[0]).toMatchObject({ passed: false });
    expect(run.results[0]!.checks.filter((check) => !check.passed)).toEqual([
      { what: 'calls check_procedure then save_procedure', passed: false, detail: 'it got as far as none of them, calling nothing' },
    ]);
  }, 30_000);

  it('runs only the scenarios asked for, and refuses one that does not exist', async () => {
    stubModel(answer('done'));
    const { service } = world({ builtIn: [SCENARIO, { ...SCENARIO, id: 'other', name: 'Other' }] });

    const started = (await service.start({ ownerId: 'user-1', only: ['other'] })) as Level2Run;
    expect((await settled(service, started.id)).results.map((result) => result.scenarioId)).toEqual(['other']);
    expect(await service.start({ ownerId: 'user-1', only: ['ghost'] })).toEqual({ unknown: ['ghost'] });
  }, 30_000);

  it('marks a run that was still going when the server restarted as interrupted', async () => {
    const { service, db } = world();
    await db.saveEvalRecord('evalScenarioRuns', { id: 'old', ownerId: 'user-1', state: 'running', startedAt: 'earlier', results: [] });

    expect(await service.recover()).toBe(1);
    expect(await service.get('user-1', 'old')).toMatchObject({ state: 'interrupted' });
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

  it('reports which declared tool failures its scenarios provoke', async () => {
    const { service } = world({ builtIn: [{ ...SCENARIO, expect: { ...SCENARIO.expect, provokes: { tool: 'read_procedure', when: 'no procedure has that id', then: 'reported' } } }] });

    expect(await service.provocations('user-1')).toEqual([{ tool: 'read_procedure', when: 'no procedure has that id' }]);
  });
});
