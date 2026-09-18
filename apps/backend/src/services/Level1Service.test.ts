import { describe, it, expect, vi, afterEach } from 'vitest';
import { BUILDER_TOOLS, type ModelProvider } from '@koala/agent-engine';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { createProcedureExecutor, type HostNodeServices } from '../engine-host/nodes/index.js';
import { MemoryDB } from '../lib/memory-db.js';
import type { EvalCase } from '../eval/cases.js';
import { Level1Service, summariseLevel1, type Level1Run } from './Level1Service.js';

const PROVIDER = { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'test-model', contextTokens: 32_000 } as ModelProvider;

const CASES: EvalCase[] = [
  { name: 'builder/reads', category: 'simple', agent: 'agent-builder', say: 'show me research', expect: { tool: 'read_procedure', args: [{ arg: 'procedure', is: 'research' }] } },
  { name: 'builder/says-nothing', category: 'irrelevance', agent: 'agent-builder', say: 'what is an agent?', expect: { tool: null } },
];

type Frame = Record<string, unknown>;
const answer = (content: string): Frame[] => [{ choices: [{ delta: { content }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } }];
const call = (name: string, args: Record<string, unknown>): Frame[] => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

function stubModel(reply: (lastUser: string, body: { messages: { role: string; content: string }[] }) => Frame[] | Promise<Frame[]>) {
  const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
    const frames = await reply(body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? '', body);
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

function world(over: { now?: () => string } = {}) {
  const registry = createAgentRegistry();
  const services: HostNodeServices = {
    registry,
    models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
    tools: { run: async () => ({ ok: true, digest: '', content: '' }) },
    environments: { describe: async () => ({ kind: 'none', egress: false }), release: async () => undefined },
    memories: { list: async () => [], save: async () => undefined },
  };
  const db = new MemoryDB();
  let ids = 0;
  const service = new Level1Service({
    executor: createProcedureExecutor(services, { registry }),
    tools: async () => [...BUILDER_TOOLS],
    agents: async () => (await registry.agents('user-1')).map((agent) => agent.slug),
    store: db,
    builtIn: CASES,
    newId: () => `run-${(ids += 1)}`,
    ...(over.now ? { now: over.now } : {}),
  });
  return { service, db };
}

const settled = async (service: Level1Service, id: string): Promise<Level1Run> => {
  for (let tries = 0; tries < 200; tries += 1) {
    const run = await service.get('user-1', id);
    if (run && run.state !== 'running') return run;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('the run never finished');
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('Level 1 evals', () => {
  it('asks the model through the real Model Turn and keeps every attempt: prompt, tools offered, reply, tokens and latency', async () => {
    const model = stubModel((said) => (said.includes('what is') ? answer('an agent is a persona with a procedure') : call('read_procedure', { procedure: 'research' })));
    const { service } = world();

    const started = await service.start({ ownerId: 'user-1', repeats: 2 });
    const run = await settled(service, (started as Level1Run).id);
    const reads = run.results.find((result) => result.name === 'builder/reads')!;
    const prompt = await service.prompt('user-1', reads.attempts[0]!.systemHash!);

    expect(run.state).toBe('done');
    expect(reads.attempts).toHaveLength(2);
    expect(reads.attempts[0]).toMatchObject({ passed: true, toolCalls: [{ name: 'read_procedure', arguments: '{"procedure":"research"}' }], toolsOffered: expect.arrayContaining(['read_procedure', 'save_procedure']) });
    expect(run.results.find((result) => result.name === 'builder/says-nothing')!.attempts[0]).toMatchObject({ passed: true, content: 'an agent is a persona with a procedure', totalTokens: 920 });
    expect(prompt).toBe(JSON.parse((model.mock.calls[0]![1] as { body: string }).body).messages[0].content);
    expect(summariseLevel1(run).reliability).toEqual({ cases: 2, always: 2, never: 0, flaky: 0 });
  });

  it('says why an attempt failed', async () => {
    stubModel(() => call('read_procedure', { procedure: 'planning' }));
    const { service } = world();

    const run = await settled(service, ((await service.start({ ownerId: 'user-1', repeats: 1, only: ['builder/reads'] })) as Level1Run).id);

    expect(run.results[0]!.attempts[0]).toMatchObject({ passed: false, complaint: 'read_procedure sent "procedure" as planning, wanted research' });
  });

  it('stops part way through when cancelled, keeping what finished', async () => {
    let release: () => void = () => undefined;
    stubModel(async (said) => {
      if (said.includes('what is')) await new Promise<void>((done) => { release = done; });
      return answer('ok');
    });
    const { service } = world();

    const started = (await service.start({ ownerId: 'user-1', repeats: 1 })) as Level1Run;
    await vi.waitFor(async () => expect((await service.get('user-1', started.id))?.running).toBe('builder/says-nothing'));
    expect(service.cancel('user-1', started.id)).toBe(true);
    release();
    const run = await settled(service, started.id);

    expect(run.state).toBe('cancelled');
    expect(run.results.map((result) => result.name)).toEqual(['builder/reads', 'builder/says-nothing']);
    expect(run.results[0]!.attempts).toHaveLength(1);
  });

  it('marks a run that was still going when the server restarted as interrupted', async () => {
    const { service, db } = world({ now: () => '2026-09-17T12:00:00.000Z' });
    await db.saveEvalRecord('evalLevel1Runs', { id: 'old', ownerId: 'user-1', state: 'running', startedAt: 'earlier', results: [] });

    expect(await service.recover()).toBe(1);
    expect(await service.get('user-1', 'old')).toMatchObject({ state: 'interrupted', error: 'the server restarted while this ran, so it stopped here' });
  });

  it('refuses to start with a case that does not exist', async () => {
    const { service } = world();
    expect(await service.start({ ownerId: 'user-1', only: ['builder/ghost'] })).toEqual({ unknown: ['builder/ghost'] });
  });
});

describe('Level 1 cases as data', () => {
  it('saves a case of the caller\'s own, which replaces a built-in of the same name for them only', async () => {
    const { service } = world();
    const edited = { ...CASES[0]!, say: 'open the research procedure' };

    expect(await service.saveCase('user-1', edited)).toMatchObject({ saved: true });
    expect((await service.cases('user-1')).find((entry) => entry.name === 'builder/reads')).toMatchObject({ say: 'open the research procedure', mine: true });
    expect((await service.cases('user-2')).find((entry) => entry.name === 'builder/reads')).toMatchObject({ say: 'show me research', mine: false });
    expect(await service.deleteCase('user-1', 'builder/reads')).toBe(true);
    expect((await service.cases('user-1')).find((entry) => entry.name === 'builder/reads')?.mine).toBe(false);
  });

  it('says everything wrong with a case it will not save', async () => {
    const { service } = world();
    const outcome = await service.saveCase('user-1', {
      name: 'Bad Name', category: 'irrelevance', agent: 'ghost', say: ' ',
      expect: { tool: 'read_procedure', args: [{ arg: 'nope', is: 'x' }] },
    });

    expect(outcome).toEqual({
      saved: false,
      problems: [
        'the name has to look like group/what-it-checks, in lower case',
        'there is no agent called "ghost"',
        'the case has to say something to the agent',
        'an irrelevance case expects no tool call',
        'read_procedure has no argument called "nope"',
      ],
    });
  });

  it('counts a tool failure a Level 2 scenario provokes as covered', async () => {
    const tool = BUILDER_TOOLS.find((candidate) => candidate.failures.length > 0)!;
    const failure = tool.failures[0]!;
    const { service } = world();
    const without = await service.coverage('user-1');
    const withScenario = new Level1Service({ ...(service as unknown as { options: ConstructorParameters<typeof Level1Service>[0] }).options, provokedByScenarios: async () => [{ tool: tool.name, when: failure.when }] });

    const flagged = (problems: Awaited<ReturnType<Level1Service['coverage']>>) =>
      problems.some((problem) => problem.kind === 'unprovoked' && problem.case === tool.name && problem.message.includes(`"${failure.when}"`));

    expect(flagged(without)).toBe(true);
    expect(flagged(await withScenario.coverage('user-1'))).toBe(false);
  });

  it('compares two runs', async () => {
    const { service, db } = world();
    const run = (id: string, passed: boolean): Level1Run => ({
      id, ownerId: 'user-1', state: 'done', startedAt: id, repeats: 1, toolCatalogueHash: 'x', cases: ['builder/reads'], finished: 1,
      results: [{ name: 'builder/reads', category: 'simple', agent: 'agent-builder', expects: 'read_procedure', attempts: [{ attempt: 0, passed, toolsOffered: [], content: '', thinking: '', toolCalls: [], promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 }] }],
    });
    await db.saveEvalRecord('evalLevel1Runs', run('a', false));
    await db.saveEvalRecord('evalLevel1Runs', run('b', true));

    expect((await service.compare('user-1', 'a', 'b'))?.cases).toEqual([{ name: 'builder/reads', before: { passed: 0, attempts: 1 }, after: { passed: 1, attempts: 1 }, change: 1 }]);
    expect(await service.compare('user-2', 'a', 'b')).toBeUndefined();
  });
});
