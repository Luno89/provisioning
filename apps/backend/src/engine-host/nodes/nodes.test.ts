import { describe, it, expect, vi, afterEach } from 'vitest';
import { ALL_SEEDED_AGENTS, createEventBus, fittedMaxTokens, type AgentDefinition, type EngineEvent, type Monitor, type ModelProvider } from '@koala/agent-engine';
import {
  BUILT_IN_GROUPS,
  DO_ONE_TASK_V2,
  PROCEDURE_SCHEMA,
  TOOL_ROUNDS_V2,
  builtInCatalogue,
  runProcedure,
  type NodeTrace,
  type Procedure,
} from '@koala/agent-engine/procedure';
import type { ToolContract } from '@koala/engine-core';
import { createAgentRegistry } from '../registries/registry.js';
import { createEnvironmentResolver } from '../sandboxes/environments.js';
import { createRunEnvironments } from '../sandboxes/run-environments.js';
import { createSandboxDriver } from '../drivers/sandbox.js';
import type { MemoryItem } from '../drivers/memory-store.js';
import type { RunTicket, ToolCallArgs, ToolCallOutcome } from '../temporal/contracts.js';
import { procedureBuilder } from '@koala/agent-engine/procedure-builder';
import { createProcedureExecutor, withTemperature, type HostNodeServices } from './index.js';
import { inMemoryConversations } from './conversation-nodes.js';
import { INTERACTIVE_CHAT_V3 } from '@koala/agent-engine/procedure';

const CATALOGUE: ToolContract[] = [
  { name: 'run_command', description: 'Run a shell command', binding: 'environment', requires: { terminal: true }, usageGuidance: 'Prefer a dedicated tool when one fits.' },
  { name: 'read_file', description: 'Read a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'write_file', description: 'Write a file', binding: 'environment', requires: { filesystem: true } },
  { name: 'list_dir', description: 'List a directory', binding: 'environment', requires: { filesystem: true } },
  { name: 'search_web', description: 'Search the web', binding: 'network' },
  { name: 'fetch_web_page', description: 'Fetch a page', binding: 'network' },
  { name: 'propose_work', description: 'Propose a unit of work', binding: 'platform' },
  { name: 'request_egress', description: 'Ask for a host to be reachable', binding: 'platform' },
  { name: 'list_tasks', description: 'List tasks', binding: 'platform' },
  { name: 'start_task', description: 'Start a task', binding: 'platform' },
  { name: 'mark_done', description: 'Finish a task', binding: 'platform' },
  { name: 'list_references', description: 'List references', binding: 'platform' },
  { name: 'read_procedure', description: 'Read a procedure', binding: 'platform' },
  { name: 'check_procedure', description: 'Compile a procedure', binding: 'platform' },
  { name: 'save_procedure', description: 'Write a procedure', binding: 'platform' },
];

const SANDBOXED: AgentDefinition = {
  slug: 'sandboxed',
  name: 'Sandboxed',
  description: 'works in a sandbox',
  version: '1',
  prompt: '  You build things in a sandbox.  ',
  procedure: 'tool-rounds',
  guidance: '',
  returns: '',
  failures: [],
  tools: ['run_command', 'read_file', 'search_web', 'request_egress'],
  agents: ['research'],
  budget: { maxRounds: 4 },
  environment: { terminal: true, filesystem: true, languages: ['node'] },
  interface: { workspace: true, outputs: ['summary'] },
};

const CEILINGED: AgentDefinition = {
  ...SANDBOXED,
  slug: 'ceilinged',
  name: 'Ceilinged',
  model: { replyCeiling: 1_234 },
};

const PERSONAS = [...ALL_SEEDED_AGENTS(), SANDBOXED, CEILINGED];

const PROVIDER = {
  id: 'tabby',
  name: 'Tabby',
  source: 'deployment',
  model: 'test-model',
  contextTokens: 32_000,
} as ModelProvider;

type Frame = Record<string, unknown>;

const answer = (content: string): Frame[] => [{ choices: [{ delta: { content }, finish_reason: 'stop' }] }];

const toolCall = (id: string, name: string, args: Record<string, unknown>): Frame[] => [
  { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
];

function stubModel(...turns: Frame[][]) {
  let turn = 0;
  const fetchImpl = vi.fn(async () => {
    const frames = turns[Math.min(turn, turns.length - 1)]!;
    turn += 1;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: (async function* () {
        for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n`;
        yield 'data: [DONE]\n';
      })(),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchImpl);

  return {
    fetchImpl,
    bodies: () => fetchImpl.mock.calls.map((call) => JSON.parse((call as unknown as [string, { body: string }])[1].body) as {
      messages: { role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }[];
      tools?: unknown[];
      max_tokens: number;
    }),
  };
}

function world(over: { memories?: MemoryItem[]; tools?: (args: ToolCallArgs) => Promise<ToolCallOutcome> } = {}) {
  const registry = createAgentRegistry({
    agentStore: { list: async () => PERSONAS },
    toolCatalogue: { list: async () => CATALOGUE },
  });
  const released: string[] = [];
  const resolver = createEnvironmentResolver({
    registry,
    environments: createRunEnvironments({
      provision: async ({ id, spec }) => createSandboxDriver({
        sandboxId: id,
        spec,
        backend: {
          exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
          readFile: async () => '',
          writeFile: async () => undefined,
          listDir: async () => [],
          deleteFile: async () => undefined,
        },
      }),
    }),
    images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
    tools: async () => [],
  });
  const environments = {
    describe: (ticket: RunTicket) => resolver.describe(ticket),
    release: async (runId: string) => {
      released.push(runId);
      await resolver.release(runId);
    },
  };
  const toolRuns = vi.fn(over.tools ?? (async () => ({ ok: true, digest: 'done', content: 'done' })));
  const saved: MemoryItem[] = [];

  const services: HostNodeServices = {
    conversations: inMemoryConversations(),
    registry,
    models: { resolveBaseUrl: async () => ({ provider: PROVIDER, baseUrl: 'https://models.test/v1', apiKey: 'k' }) },
    tools: { run: toolRuns },
    environments,
    memories: { list: async () => over.memories ?? [], save: async (item) => { saved.push(item); } },
    now: () => '2026-09-16T00:00:00.000Z',
    newId: () => 'memory-1',
  };

  return { services, toolRuns, released, saved };
}

const identity = (slug: string, runId = `run-${slug}`) => ({
  runId,
  depth: 0,
  agentId: slug,
  loopId: 'tool-rounds',
  loopVersion: '2',
  trigger: 'user' as const,
});

function runV2(
  services: HostNodeServices,
  slug: string,
  procedure: Procedure = TOOL_ROUNDS_V2,
  over: {
    traces?: NodeTrace[];
    message?: string;
    launch?: Partial<Parameters<typeof runProcedure>[0]['launch']>;
    inputs?: Record<string, unknown>;
    bus?: Parameters<typeof runProcedure>[0]['bus'];
  } = {},
) {
  return runProcedure({
    procedure,
    catalogue: builtInCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor: createProcedureExecutor(services, { registry: services.registry as never }),
    identity: identity(slug),
    launch: { ownerId: 'user-1', ...(over.launch ?? {}) },
    inputs: { message: over.message ?? 'get on with it', ...(over.inputs ?? {}) },
    ...(over.bus ? { bus: over.bus } : {}),
    ...(over.traces ? { onTrace: (trace) => over.traces!.push(trace) } : {}),
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('how much room a reply gets', () => {
  const roomFor = (chars: number) => fittedMaxTokens(
    { contextTokens: 32_000, contextMargin: 1000, minReplyTokens: 512 } as never,
    Number.MAX_SAFE_INTEGER,
    chars,
    32_000,
  );

  it('gives a reply whatever the window has room for while the model has no track record', async () => {
    const { services } = world();
    const model = stubModel(answer('ok'));

    await runV2(services, 'research');
    const [sent] = model.bodies();
    const chars = sent!.messages.reduce((total, message) => total + message.content.length, 0);

    expect(sent!.max_tokens).toBe(roomFor(chars));
    expect(sent!.max_tokens).toBeGreaterThan(4096);
  });

  it('holds a reply to what the model typically needs once it has a track record', async () => {
    const { services } = world();
    const model = stubModel(answer('ok'));

    await runV2({ ...services, efforts: { replyCeiling: async () => 2_048 } }, 'research');

    expect(model.bodies()[0]!.max_tokens).toBe(2_048);
  });

  it('reports the cap that cut a reply off, so the next run can be given more', async () => {
    const { services } = world();
    stubModel([{ choices: [{ delta: { content: 'as far as it g' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]);

    const result = await runV2({ ...services, efforts: { replyCeiling: async () => 700 } }, 'research');

    expect(result.counters.cappedAt).toBe(700);
  });

  it('says nothing was cut off when the model finished on its own', async () => {
    const { services } = world();
    stubModel(answer('all of it'));

    const result = await runV2({ ...services, efforts: { replyCeiling: async () => 700 } }, 'research');

    expect(result.counters.cappedAt).toBe(0);
  });

  it('lets a persona set its own ceiling, and never asks the track record then', async () => {
    const { services } = world();
    const model = stubModel(answer('ok'));
    const replyCeiling = vi.fn(async () => 2_048);

    await runV2({ ...services, efforts: { replyCeiling } }, 'ceilinged');

    expect(model.bodies()[0]!.max_tokens).toBe(1_234);
    expect(replyCeiling).not.toHaveBeenCalled();
  });
});

describe('calling the model', () => {
  const streamed = (...frames: Frame[]) => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => '',
      body: (async function* () {
        for (const frame of frames) yield `data: ${JSON.stringify(frame)}\n`;
        yield 'data: [DONE]\n';
      })(),
    } as unknown as Response));
    vi.stubGlobal('fetch', fetchImpl);
    return fetchImpl;
  };

  it('sends the agent its own prompt, its environment and its tools, not a bare user message', async () => {
    const { services } = world();
    const model = stubModel(answer('ok'));

    await runV2(services, 'sandboxed');
    const [sent] = model.bodies();
    const system = sent!.messages.find((message) => message.role === 'system');

    expect(system, 'the model was called with no system prompt at all').toBeDefined();
    expect(system!.content).toContain('YOUR EXECUTION ENVIRONMENT');
    expect(system!.content.startsWith('You build things in a sandbox.')).toBe(true);
    expect(sent!.messages.at(-1)).toMatchObject({ role: 'user', content: 'get on with it' });
    expect(sent!.tools?.length ?? 0).toBeGreaterThan(0);
  });

  it('streams thinking and content onto the bus while returning the finished reply', async () => {
    streamed(
      { choices: [{ delta: { reasoning_content: 'weighing it up' } }] },
      { choices: [{ delta: { content: 'the answer' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    );

    const { services } = world();
    const bus = createEventBus();
    const events: EngineEvent[] = [];
    bus.subscribe((event) => { events.push(event); });

    const result = await runV2(services, 'sandboxed', TOOL_ROUNDS_V2, { bus });

    expect(result.outcome).toBe('ok');
    expect(events.filter((event) => event.type === 'thinking')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'content')).toHaveLength(1);
    expect(events.find((event) => event.type === 'content')).toMatchObject({ runId: 'run-sandboxed', delta: 'the answer' });
  });

  it('stops the run when a stream monitor interrupts', async () => {
    streamed(
      { choices: [{ delta: { reasoning_content: 'round and round' } }] },
      { choices: [{ delta: { content: 'never gets here' } }] },
    );

    const spinning: Monitor = { name: 'spinning', onThinking: () => 'caught looping' };
    const { services } = world();

    const result = await runV2({ ...services, streamMonitors: () => [spinning] }, 'sandboxed');

    expect(result.outcome).toBe('interrupted');
    expect(result.reason).toContain('caught looping (spinning)');
  });

  it('resolves the endpoint for the persona that is being called', async () => {
    const { services } = world();
    const resolveBaseUrl = vi.fn(services.models.resolveBaseUrl);
    stubModel(answer('ok'));

    await runV2({ ...services, models: { resolveBaseUrl } }, 'research', TOOL_ROUNDS_V2, { launch: { modelId: 'chosen-model' } });

    expect(resolveBaseUrl).toHaveBeenCalledWith('user-1', 'chosen-model', undefined);
  });
});

describe('running tool-rounds node by node', () => {
  it('sizes the reply against the prompt it actually sends', async () => {
    const { services } = world();
    const model = stubModel(answer('ok'));

    await runV2({ ...services, efforts: { replyCeiling: async () => 16_384 } }, 'agent-builder');
    const [sent] = model.bodies();
    const chars = sent!.messages.reduce((total, message) => total + message.content.length, 0);

    expect(sent!.max_tokens).toBe(fittedMaxTokens(
      { contextTokens: 32_000, contextMargin: 1000, minReplyTokens: 512 } as never,
      16_384,
      chars,
      32_000,
    ));
  });

  it('runs the tools a reply asks for and answers each call by id on the next turn', async () => {
    const { services, toolRuns } = world({ tools: async () => ({ ok: true, digest: '{"scripts":{}}', content: '{"scripts":{}}' }) });
    const model = stubModel(toolCall('call-7', 'read_file', { path: 'package.json' }), answer('There is no build script.'));
    const traces: NodeTrace[] = [];

    const result = await runV2(services, 'sandboxed', TOOL_ROUNDS_V2, { traces });
    const [, second] = model.bodies();

    expect(result.outcome).toBe('ok');
    expect(toolRuns).toHaveBeenCalledWith(expect.objectContaining({
      name: 'read_file',
      arguments: '{"path":"package.json"}',
      callId: 'call-7',
      granted: SANDBOXED.tools,
      environment: expect.objectContaining({ id: expect.any(String) }),
    }));
    expect(second!.messages.slice(1)).toEqual([
      { role: 'user', content: 'get on with it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-7', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
      { role: 'tool', content: '{"scripts":{}}', tool_call_id: 'call-7', name: 'read_file' },
    ]);
    expect(traces.filter((trace) => trace.kind === 'call-model').map((trace) => trace.exit)).toEqual(['toolCalls', 'answered']);
    expect(result.counters).toMatchObject({ rounds: 2, toolCalls: 1 });
  });

  it('releases the sandbox however the run ends', async () => {
    const { services, released } = world();
    stubModel(answer(''));

    const result = await runV2(services, 'sandboxed');

    expect(result).toMatchObject({ outcome: 'failed', reason: 'stopped without saying what it did' });
    expect(released).toEqual(['run-sandboxed']);
  });

  it('ends the run with the reason when no environment can be provided', async () => {
    const { services } = world();
    services.environments.describe = async () => { throw new Error('the cluster is unreachable'); };
    stubModel(answer('ok'));

    expect(await runV2(services, 'sandboxed')).toMatchObject({
      outcome: 'failed',
      reason: 'no environment could be provided: the cluster is unreachable',
    });
  });

  it('stops when tool calls keep failing', async () => {
    const { services } = world({ tools: async () => ({ ok: false, digest: 'permission denied', content: 'permission denied' }) });
    stubModel(
      toolCall('c1', 'run_command', { command: 'a' }),
      toolCall('c2', 'run_command', { command: 'b' }),
      toolCall('c3', 'run_command', { command: 'c' }),
      answer('never reached'),
    );

    expect(await runV2(services, 'sandboxed')).toMatchObject({ outcome: 'failed', reason: '3 tool calls failed in a row' });
  });

  it('puts memories in the prompt, which today\'s engine never did', async () => {
    const memory: MemoryItem = {
      id: 'm1', ownerId: 'user-1', category: 'environment_facts', scope: 'global', status: 'active',
      title: 'Registry', text: 'Images are pushed to the in-cluster Gitea registry.', createdAt: '2026-09-01', updatedAt: '2026-09-01',
    };
    const { services } = world({ memories: [memory] });
    const model = stubModel(answer('ok'));

    await runV2(services, 'research');

    expect(model.bodies()[0]!.messages[0]!.content).toContain('- Registry: Images are pushed to the in-cluster Gitea registry.');
  });
});

describe('host nodes', () => {
  it('uses the run\'s sampling over the persona\'s, and a set temperature over both', () => {
    const persona = { toolTurn: { temperature: 0.6, top_p: 0.9 }, conversation: { temperature: 0.7 } };

    expect(withTemperature(persona, undefined)).toBe(persona);
    expect(withTemperature(persona, 0.2)).toEqual({ toolTurn: { temperature: 0.2, top_p: 0.9 }, conversation: { temperature: 0.2 } });
    expect(withTemperature(undefined, 0.2)).toEqual({ toolTurn: { temperature: 0.2 }, conversation: { temperature: 0.2 } });
  });
});

describe('deciding yes or no with a model', () => {
  const deciding: Procedure = {
    schema: PROCEDURE_SCHEMA,
    id: 'decide-check',
    version: '1',
    name: 'Decide check',
    describe: '',
    budget: {},
    start: 'verdict',
    nodes: [
      { id: 'persona', kind: 'persona', settings: {}, position: { x: 0, y: 0 } },
      { id: 'model', kind: 'choose-model', settings: {}, position: { x: 0, y: 0 } },
      { id: 'judged', kind: 'text', settings: { text: 'Verdict: unproven. Only two inputs were tried.' }, position: { x: 0, y: 0 } },
      { id: 'verdict', kind: 'decide', settings: { question: 'Does this verdict say the work passed?' }, position: { x: 0, y: 0 } },
      { id: 'passed', kind: 'finish', settings: { outcome: 'ok', reason: 'passed' }, position: { x: 0, y: 0 } },
      { id: 'notPassed', kind: 'finish', settings: { outcome: 'failed', reason: 'did not pass' }, position: { x: 0, y: 0 } },
      { id: 'unclear', kind: 'finish', settings: { outcome: 'failed', reason: 'unclear' }, position: { x: 0, y: 0 } },
    ],
    wires: [
      { from: { node: 'persona', socket: 'persona' }, to: { node: 'model', socket: 'persona' } },
      { from: { node: 'model', socket: 'binding' }, to: { node: 'verdict', socket: 'binding' } },
      { from: { node: 'judged', socket: 'text' }, to: { node: 'verdict', socket: 'text' } },
    ],
    flow: [
      { from: 'verdict', exit: 'yes', to: 'passed' },
      { from: 'verdict', exit: 'no', to: 'notPassed' },
      { from: 'verdict', exit: 'unsure', to: 'unclear' },
    ],
    groups: [],
  };

  it('asks the question about the text and leaves by the answer the model gave, counting the call as a round', async () => {
    const { services } = world();
    const model = stubModel(answer('No\nThe judge said it was unproven.'));
    const traces: NodeTrace[] = [];

    const result = await runV2(services, 'sandboxed', deciding, { traces });
    const [body] = model.bodies();

    expect(result).toMatchObject({ outcome: 'failed', reason: 'did not pass', counters: { rounds: 1 } });
    expect(body!.messages.at(-1)?.content).toBe('Question: Does this verdict say the work passed?\n\nText:\nVerdict: unproven. Only two inputs were tried.');
    expect(traces.find((trace) => trace.kind === 'decide')?.outputs).toEqual({ decision: 'no', why: 'No\nThe judge said it was unproven.' });
  });

  it('gives the decision the room the window has, rather than a fixed cap', async () => {
    const { services } = world();
    const model = stubModel(answer('No'));

    await runV2(services, 'sandboxed', deciding);
    const [body] = model.bodies();
    const chars = body!.messages.reduce((total, message) => total + message.content.length, 0);

    expect(body!.max_tokens).toBe(fittedMaxTokens(
      { contextTokens: 32_000, contextMargin: 1000, minReplyTokens: 512 } as never,
      Number.MAX_SAFE_INTEGER,
      chars,
      32_000,
    ));
  });

  it('holds the decision to what the model typically needs once it has a track record', async () => {
    const { services } = world();
    const model = stubModel(answer('No'));

    await runV2({ ...services, efforts: { replyCeiling: async () => 900 } }, 'sandboxed', deciding);

    expect(model.bodies()[0]!.max_tokens).toBe(900);
  });

  it('treats an answer that is not yes or no as unsure', async () => {
    const { services } = world();
    stubModel(answer('It depends on what was expected.'));

    expect(await runV2(services, 'sandboxed', deciding)).toMatchObject({ reason: 'unclear' });
  });
});

describe('handing a workspace to a delegated run', () => {
  it('lets the child work where the work was done, and leaves the sandbox for its owner to release', async () => {
    const { services, released } = world();
    const model = stubModel(answer('ok'));

    const procedure = procedureBuilder({ catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS })({
      id: 'hands-over', version: '1', name: 'Hands over', describe: 'Gives its workspace to a child.', budget: {},
    }, (p) => {
      const provision = p.provisionSandbox('provision');
      const look = p.delegate('look', { environment: provision.environment }, { agent: 'research', inputs: '{"question":"what is here"}' });
      const done = p.finish('done', {}, { outcome: 'ok' });
      const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
      const release = p.releaseSandbox('release', { environment: provision.environment });
      const released2 = p.finish('released', {}, { outcome: 'ok' });

      p.start(provision);
      p.cleanup(release);
      provision.on('ready', look);
      provision.on('unavailable', unavailable);
      look.on('ok', done);
      look.on('failed', done);
      release.on('done', released2);
      p.layout({ provision: [0, 0], look: [260, 0], done: [520, 0], unavailable: [260, 140], release: [0, 140], released: [260, 280] });
    }).procedure;

    const result = await runV2(services, 'sandboxed', procedure);

    expect(result.outcome).toBe('ok');

    const [childCall] = model.bodies();
    const system = childCall!.messages.find((message) => message.role === 'system')?.content ?? '';

    expect(system, 'the child was not told it has the workspace').toContain('ubi9/nodejs-22');
    expect(system).not.toContain('You have no machine this turn');
    expect(released, 'the child released a sandbox it did not create').toEqual(['run-sandboxed']);
  });
});

describe('doing one task', () => {
  const task = { id: 'task-1', title: 'Write hello.txt', doneMeans: 'hello.txt contains the word hello' };

  const doTask = (services: HostNodeServices) => runProcedure({
    procedure: DO_ONE_TASK_V2,
    catalogue: builtInCatalogue(),
    groups: BUILT_IN_GROUPS,
    executor: createProcedureExecutor(services, { registry: services.registry as never }),
    identity: { ...identity('executor'), loopId: 'do-one-task' },
    launch: { ownerId: 'user-1' },
    inputs: { item: task, message: JSON.stringify({ item: task }) },
  });

  it('asks the judge about the work, has a model read the verdict, and marks the task done when it passed', async () => {
    const { services, toolRuns } = world();
    const model = stubModel(answer('I wrote hello.txt with the word hello in it.'), answer('Verdict: met. The file holds the word.'), answer('yes\nThe judge says it is met.'));

    const result = await doTask(services);
    const [, judged, decided] = model.bodies();

    expect(result).toMatchObject({ outcome: 'ok' });
    expect(judged!.messages.at(-1)?.content).toBe(`work: I wrote hello.txt with the word hello in it.\n\nexpected: ${task.doneMeans}`);
    expect(decided!.messages.at(-1)?.content).toContain('Verdict: met. The file holds the word.');
    expect(toolRuns.mock.calls.map(([call]) => [call!.name, JSON.parse(call!.arguments)])).toEqual([
      ['start_task', { taskId: 'task-1' }],
      ['mark_done', { taskId: 'task-1', evidence: 'I wrote hello.txt with the word hello in it.' }],
    ]);
  });

  it('marks the task failed, saying why, when the verdict is not a pass', async () => {
    const { services, toolRuns } = world();
    stubModel(answer('I think it is done.'), answer('Verdict: unproven. Nothing shows the file exists.'), answer('no\nThe judge found no evidence the file exists.'));

    const result = await doTask(services);

    expect(result).toMatchObject({ outcome: 'failed', reason: 'the judge did not accept the work' });
    expect(toolRuns.mock.calls.map(([call]) => [call!.name, JSON.parse(call!.arguments)])).toEqual([
      ['start_task', { taskId: 'task-1' }],
      ['mark_failed', { taskId: 'task-1', reason: 'no\nThe judge found no evidence the file exists.' }],
    ]);
  });
});


describe('a tool the procedure does itself', () => {
  const withHandledStep = (shared: boolean): Procedure =>
    procedureBuilder({ catalogue: builtInCatalogue(), groups: BUILT_IN_GROUPS })({
      id: 'handled', version: '1', name: 'Handled', describe: 'Claims a task, then calls the model.', budget: {},
    }, (p) => {
      const persona = p.persona('persona');
      const input = p.runInput('input');
      const claim = p.callTool('claim', { persona: persona.persona }, {
        tool: 'start_task',
        args: '{"taskId":"t-1"}',
        says: 'The task has already been claimed for you.',
        ...(shared ? { shared: true } : {}),
      });
      const conversation = p.conversation('conversation', { opening: input.message });
      const turn = p.groups.modelTurn('turn', { messages: conversation.messages });
      const done = p.finish('done', { result: turn.content }, { outcome: 'ok' });
      const stopped = p.finish('stopped', {}, { outcome: 'failed', reason: 'it stopped' });

      p.start(claim);
      claim.on('ok', conversation);
      claim.on('failed', stopped);
      conversation.on('done', turn);
      turn.on('answered', done);
      turn.on('truncated', done);
      turn.on('toolCalls', done);
      turn.on('empty', stopped);
      p.layout({
        persona: [0, 0], input: [0, 140], claim: [260, 0], conversation: [520, 0],
        turn: [780, 0], done: [1040, 0], stopped: [1040, 140],
      });
    }).procedure;

  const started = async () => ({ ok: true, digest: 'started t-1' });

  it('is not offered to the model, and the model is told what happens instead', async () => {
    const { services } = world({ tools: started });
    const model = stubModel(answer('done'));

    await runV2(services, 'executor', withHandledStep(false));

    const [sent] = model.bodies();
    const offered = (sent!.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name);
    const system = sent!.messages.find((message) => message.role === 'system')!.content;

    expect(offered).not.toContain('start_task');
    expect(system).toContain('WHAT THE PROCEDURE DOES AROUND YOU');
    expect(system).toContain('The task has already been claimed for you.');
  });

  it('is offered again once the step is shared with the model', async () => {
    const { services } = world({ tools: started });
    const model = stubModel(answer('done'));

    await runV2(services, 'executor', withHandledStep(true));

    const [sent] = model.bodies();
    const offered = (sent!.tools ?? []).map((tool) => (tool as { function: { name: string } }).function.name);

    expect(offered).toContain('start_task');
    expect(sent!.messages.find((message) => message.role === 'system')!.content)
      .not.toContain('WHAT THE PROCEDURE DOES AROUND YOU');
  });
});

describe('a turn the model stream cut short', () => {
  const brokenAfter = (said: string): Frame[] => [
    { choices: [{ delta: { content: said } }] },
    { error: 'Chat completion aborted. Please check the server console.' },
  ];

  it('keeps what arrived before it broke, instead of throwing it away', async () => {
    const { services } = world();
    stubModel(brokenAfter('I was part way through saying'));

    const result = await runV2(services, 'koala', INTERACTIVE_CHAT_V3, { message: 'tell me something' });

    expect(result.outcome).toBe('interrupted');
    expect(result.reason).toContain('Model stream error');
  });

  it('records the half-finished reply on the conversation, because remembering is cleanup', async () => {
    const conversations = inMemoryConversations();
    const { services } = world();
    stubModel(brokenAfter('half a thought'));

    await runV2({ ...services, conversations }, 'koala', INTERACTIVE_CHAT_V3, {
      message: 'tell me something',
      inputs: { conversationId: 'cut-short' },
    });

    const saved = await conversations.get('user-1', 'cut-short');
    expect(saved?.messages.map((one) => one.content)).toEqual(['tell me something', 'half a thought']);
  });

  it('still records the turn when the whole reply arrived', async () => {
    const conversations = inMemoryConversations();
    const { services } = world();
    stubModel(answer('a whole thought'));

    await runV2({ ...services, conversations }, 'koala', INTERACTIVE_CHAT_V3, {
      message: 'tell me something',
      inputs: { conversationId: 'complete' },
    });

    const saved = await conversations.get('user-1', 'complete');
    expect(saved?.messages.map((one) => one.content)).toEqual(['tell me something', 'a whole thought']);
  });
});
