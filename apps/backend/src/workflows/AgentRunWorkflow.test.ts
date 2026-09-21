import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { ModelProvider } from '@koala/agent-engine';
import {
  PROCEDURE_SCHEMA,
  REFUSED_CALL,
  RESEARCH_V2,
  TOOL_ROUNDS_V2,
  INTERACTIVE_CHAT_V3,
  replyExit,
  stepImplementation,
  type ChatMessage,
  type ModelReply,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { AgentRunWorkflow, answerSignal, approveSignal, cancelSignal } from './AgentRunWorkflow.js';
import { createNodeRunner } from '../engine-host/temporal/activities.js';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { createEffortTracker, type RunLimitsArgs } from '../engine-host/registries/effort.js';
import type { RunEffort } from '@koala/agent-engine/procedure';
import { createHostNodes, hostNodesFor } from '../engine-host/nodes/index.js';
import { inMemoryConversations } from '../engine-host/nodes/conversation-nodes.js';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  type ProcedureRunInput,
  type PublishArgs,
  type RecordTracesArgs,
  type RunEnvironment,
  type RunTicket,
  type ToolCallArgs,
} from '../engine-host/temporal/contracts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

type Scripted = Partial<ModelReply> | Error;

const MACHINE: RunEnvironment = { kind: 'machine', deviceId: 'desk', deviceName: 'Desk', path: 'projects/thing', egressMode: 'declared' };

function activities(options: {
  script: Scripted[];
  environment?: RunEnvironment;
  history?: RunEffort[];
  conversations?: ReturnType<typeof inMemoryConversations>;
}) {
  const registry = createAgentRegistry();
  const conversations = options.conversations ?? inMemoryConversations();
  const seen: ChatMessage[][] = [];
  let turn = 0;

  const models = {
    resolveBaseUrl: async () => ({
      provider: { id: 'tabby', name: 'Tabby', source: 'deployment', model: 'm', contextTokens: 32_000 } as ModelProvider,
      baseUrl: 'http://models.test/v1',
    }),
  };

  const hostNodes = hostNodesFor(createHostNodes({
    conversations,
    registry,
    models,
    tools: { run: async () => ({ ok: true, digest: '' }) },
    environments: { describe: async () => options.environment ?? { kind: 'none', egress: false }, release: async () => undefined },
    memories: { list: async () => [], save: async () => undefined },
  }), ['activity', 'sandbox']);

  const scriptedModel = stepImplementation('call-model', ({ node, execution, inputs }) => {
    seen.push(structuredClone(inputs.messages as ChatMessage[]));
    const next = options.script[Math.min(turn, options.script.length - 1)]!;
    turn += 1;
    if (next instanceof Error) throw next;

    const reply: ModelReply = { id: `${node.id}#${execution}`, content: '', thinking: '', finishReason: 'stop', toolCalls: [], ...next };
    return { exit: replyExit(reply), outputs: { reply, toolCalls: reply.toolCalls, content: reply.content }, usage: { rounds: 1 } };
  });

  const efforts: RunEffort[] = [...(options.history ?? [])];
  const tracker = createEffortTracker({
    models,
    registry,
    store: {
      save: async (effort) => { efforts.push(effort); },
      list: async (ownerId, procedureId, modelKey) => efforts.filter((effort) =>
        effort.ownerId === ownerId && effort.procedureId === procedureId && effort.modelKey === modelKey),
    },
  });

  return {
    seen,
    efforts,
    conversations,
    engine: {
      EngineRunLimitsActivity: vi.fn((args: RunLimitsArgs) => tracker.limits(args)),
      EngineRecordEffortActivity: vi.fn((effort: RunEffort) => tracker.record(effort)),
      EngineSettleClaimsActivity: vi.fn(async (_args: { ownerId: string; runId: string; outcome: string }) => [] as string[]),
      EngineNodeActivity: createNodeRunner(hostNodes, undefined),
      EngineResolveAgentActivity: vi.fn(async ({ ownerId, agentSlug }: { ownerId: string; agentSlug: string }) => {
        const runnable = await registry.runnable(ownerId, agentSlug);
        return runnable
          ? { found: true, procedure: runnable.procedure, callableAgents: [] }
          : { found: false, callableAgents: [] };
      }),
      EngineToolActivity: vi.fn(async (args: ToolCallArgs) => ({ ok: true, digest: `ran ${args.name}`, content: `output of ${args.name}` })),
      EngineRecordTracesActivity: vi.fn(async (_args: RecordTracesArgs) => undefined),
    },
    stream: {
      EngineStreamNodeActivity: createNodeRunner([scriptedModel], undefined),
      EnginePublishActivity: vi.fn(async (_args: PublishArgs) => undefined),
    },
  };
}

type Activities = ReturnType<typeof activities>;

const ticket = (agentSlug: string): RunTicket => ({
  runId: `run-${Math.random().toString(36).slice(2, 8)}`,
  depth: 0,
  ownerId: 'user-1',
  agentSlug,
  trigger: 'user',
});

const input = (
  agentSlug: string,
  procedure: Procedure,
  message = 'hello',
  extras: Record<string, unknown> = {},
): ProcedureRunInput => ({
  ticket: ticket(agentSlug),
  procedure,
  inputs: { message, ...extras },
});

async function runWorkflow(
  args: ProcedureRunInput,
  acts: Activities,
  drive?: (handle: Awaited<ReturnType<typeof env.client.workflow.start>>) => Promise<void>,
) {
  const taskQueue = `engine-test-${Math.random().toString(36).slice(2, 8)}`;
  const engineWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'AgentRunWorkflow.ts'),
    activities: acts.engine,
  });
  const streamWorker = await Worker.create({ connection: env.nativeConnection, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: acts.stream });
  const deviceWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'device-desk',
    activities: { EngineToolActivity: acts.engine.EngineToolActivity },
  });

  const start = async () => {
    const handle = await env.client.workflow.start(AgentRunWorkflow, { args: [args], taskQueue, workflowId: args.ticket.runId });
    if (drive) await drive(handle);
    return handle.result();
  };

  return engineWorker.runUntil(() => streamWorker.runUntil(() => deviceWorker.runUntil(start)));
}

const published = (acts: Activities) =>
  acts.stream.EnginePublishActivity.mock.calls.flatMap(([args]) => args.events);

const recorded = (acts: Activities) =>
  acts.engine.EngineRecordTracesActivity.mock.calls.flatMap(([args]) => args.traces);

const place = (id: string, kind: string, settings: Record<string, unknown>) => ({ id, kind, settings, position: { x: 0, y: 0 } });

const WAITING: Procedure = {
  schema: PROCEDURE_SCHEMA,
  id: 'asks',
  version: '1',
  name: 'Asks',
  describe: 'asks a person',
  budget: { maxRounds: 2 },
  start: 'ask',
  nodes: [
    place('ask', 'wait-for-person', { prompt: 'Which database?', timeoutMinutes: 5 }),
    place('done', 'finish', { outcome: 'ok' }),
    place('gaveUp', 'finish', { outcome: 'failed' }),
  ],
  wires: [
    { from: { node: 'ask', socket: 'answer' }, to: { node: 'done', socket: 'result' } },
    { from: { node: 'ask', socket: 'reason' }, to: { node: 'gaveUp', socket: 'reason' } },
  ],
  flow: [{ from: 'ask', exit: 'answered', to: 'done' }, { from: 'ask', exit: 'unanswered', to: 'gaveUp' }],
  groups: [],
};

const delegating = (agent: string): Procedure => ({
  schema: PROCEDURE_SCHEMA,
  id: 'hands-off',
  version: '1',
  name: 'Hands off',
  describe: 'delegates',
  budget: { maxRounds: 2 },
  start: 'handOff',
  nodes: [
    place('handOff', 'delegate', { agent, inputs: '{"question":"why"}' }),
    place('done', 'finish', { outcome: 'ok' }),
    place('failed', 'finish', { outcome: 'failed' }),
  ],
  wires: [
    { from: { node: 'handOff', socket: 'outputs' }, to: { node: 'done', socket: 'result' } },
    { from: { node: 'handOff', socket: 'reason' }, to: { node: 'failed', socket: 'reason' } },
  ],
  flow: [{ from: 'handOff', exit: 'ok', to: 'done' }, { from: 'handOff', exit: 'failed', to: 'failed' }],
  groups: [],
});

const callsATool = (id: string, name: string, args: string): Scripted =>
  ({ finishReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] });

describe('AgentRunWorkflow', () => {
  it('runs a procedure to its answer, recording every node and publishing progress', async () => {
    const acts = activities({ script: [{ content: 'The answer is 42.' }] });

    const result = await runWorkflow(input('research', RESEARCH_V2), acts);

    expect(result).toMatchObject({ outcome: 'ok', agentId: 'research', outputs: { result: 'The answer is 42.' } });
    expect(recorded(acts).map((trace) => trace.kind)).toEqual(expect.arrayContaining(['provision-sandbox', 'persona', 'call-model', 'finish', 'release-sandbox']));
    expect(published(acts).map((event) => event.type)).toEqual(expect.arrayContaining(['run.started', 'node.entered', 'node.traced', 'run.finished']));
  }, 60_000);

  it('runs the tools a reply asked for and answers each call by id on the next turn', async () => {
    const acts = activities({ script: [callsATool('c1', 'read_file', '{"path":"a"}'), { content: 'a says hello' }] });

    const result = await runWorkflow(input('executor', TOOL_ROUNDS_V2), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledWith(expect.objectContaining({
      name: 'read_file',
      callId: 'c1',
      granted: expect.arrayContaining(['read_file']),
    }));
    expect(acts.seen[1]!.slice(1)).toEqual([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
      { role: 'tool', content: 'output of read_file', toolCallId: 'c1', name: 'read_file' },
    ]);
  }, 60_000);

  it('records how hard the run was, against the model it ran on, with no limit before there is a track record', async () => {
    const acts = activities({ script: [callsATool('c1', 'read_file', '{"path":"a"}'), callsATool('c2', 'read_file', '{"path":"b"}'), { content: 'done' }] });

    const run = input('executor', TOOL_ROUNDS_V2, 'read two files');
    const result = await runWorkflow(run, acts);

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineSettleClaimsActivity).toHaveBeenCalledWith({ ownerId: 'user-1', runId: run.ticket.runId, outcome: 'ok' });
    expect(acts.efforts).toEqual([expect.objectContaining({
      runId: run.ticket.runId,
      procedureId: 'tool-rounds',
      modelKey: 'tabby',
      modelLabel: 'Tabby',
      outcome: 'ok',
      rounds: 3,
      toolCalls: 2,
      ask: 'read two files',
      limits: TOOL_ROUNDS_V2.budget,
    })]);
  }, 60_000);

  it('records what a run needed without holding the next one to it, so an easy history cannot cut off a harder ask', async () => {
    const past = (index: number): RunEffort => ({
      runId: `past-${index}`, ownerId: 'user-1', agentSlug: 'executor', procedureId: 'tool-rounds', procedureVersion: '2',
      modelKey: 'tabby', modelLabel: 'Tabby', outcome: 'ok', rounds: 1, toolCalls: 0, totalTokens: 0, childRuns: 0, longestReply: 0, cappedAt: 0,
      steps: 5, wallClockMs: 0, ask: 'x', limits: {}, finishedAt: `2026-09-1${index}T00:00:00.000Z`,
    });
    const acts = activities({
      history: [0, 1, 2, 3, 4].map(past),
      script: [callsATool('c1', 'read_file', '{"path":"a"}'), callsATool('c2', 'read_file', '{"path":"b"}'), { content: 'done' }],
    });

    const result = await runWorkflow(input('executor', { ...TOOL_ROUNDS_V2, budget: {} }), acts);

    expect(result).toMatchObject({ outcome: 'ok' });
    expect(acts.efforts.at(-1)).toMatchObject({ outcome: 'ok', limits: {}, rounds: 3 });
  }, 60_000);

  it('still holds a run to a limit the procedure itself asks for', async () => {
    const acts = activities({
      script: [callsATool('c1', 'read_file', '{"path":"a"}'), callsATool('c2', 'read_file', '{"path":"b"}'), { content: 'done' }],
    });

    const result = await runWorkflow(input('executor', { ...TOOL_ROUNDS_V2, budget: { maxRounds: 2 } }), acts);

    expect(result).toMatchObject({ outcome: 'exhausted', reason: 'used all 2 rounds' });
    expect(acts.efforts.at(-1)).toMatchObject({ limits: { maxRounds: 2 } });
  }, 60_000);

  it('asks before running a call on someone\'s machine, and runs it there once allowed', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"ls"}'), { content: 'done' }] });

    const result = await runWorkflow(input('executor', TOOL_ROUNDS_V2), acts, async (handle) => {
      await handle.signal(approveSignal, { callId: 'c1', allowed: true });
    });

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(published(acts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.called', callId: 'c1' }),
      expect.objectContaining({ type: 'notice', level: 'warn', message: expect.stringContaining('run_command on Desk') }),
    ]));
  }, 60_000);

  it('never runs a declined call, and tells the model it was declined', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"rm -rf /"}'), { content: 'understood' }] });

    const result = await runWorkflow(input('executor', TOOL_ROUNDS_V2), acts, async (handle) => {
      await handle.signal(approveSignal, { callId: 'c1', allowed: false });
    });

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolActivity).not.toHaveBeenCalled();
    expect(acts.seen[1]!.at(-1)).toEqual({ role: 'tool', content: REFUSED_CALL, toolCallId: 'c1', name: 'run_command' });
  }, 60_000);

  it('pauses for a person and carries on with their answer', async () => {
    const acts = activities({ script: [{ content: 'unused' }] });

    const result = await runWorkflow(input('koala', WAITING), acts, async (handle) => {
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'the staging one' });
    });

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'the staging one' } });
    expect(published(acts)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', message: 'Which database?' })]));
  }, 60_000);

  it('gives up when nobody answers in time', async () => {
    const result = await runWorkflow(input('koala', WAITING), activities({ script: [{ content: 'unused' }] }));

    expect(result).toMatchObject({ outcome: 'failed', reason: 'nobody answered in time' });
  }, 60_000);

  it('stops a waiting run when it is cancelled', async () => {
    const result = await runWorkflow(input('koala', WAITING), activities({ script: [{ content: 'unused' }] }), async (handle) => {
      await handle.signal(cancelSignal);
    });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'the run was cancelled' });
  }, 60_000);

  it('runs a delegated persona as a child workflow on that persona\'s own procedure', async () => {
    const acts = activities({ script: [{ content: 'because it was' }] });

    const result = await runWorkflow(input('koala', delegating('research')), acts);

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'because it was' } });
    expect(acts.engine.EngineResolveAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'research' }));
    expect(acts.seen[0]![0]).toEqual({ role: 'user', content: '{"question":"why"}' });
  }, 60_000);

  it('fails a delegation readably when the persona does not exist', async () => {
    const result = await runWorkflow(input('koala', delegating('ghost')), activities({ script: [{ content: 'unused' }] }));

    expect(result).toMatchObject({ outcome: 'failed', reason: 'ghost did not finish: there is no agent called "ghost"' });
  }, 60_000);

  it('fails the run, naming the step, when the model cannot be reached, and still cleans up', async () => {
    const acts = activities({ script: [new Error('the endpoint is down')] });

    const result = await runWorkflow(input('research', RESEARCH_V2), acts);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/^"turn" failed/);
    expect(recorded(acts).some((trace) => trace.kind === 'release-sandbox')).toBe(true);
  }, 120_000);
});

describe('a remembered conversation, through the workflow', () => {
  it('writes the turn across the activity boundary, not just in process', async () => {
    const acts = activities({ script: [{ content: 'burnt orange, noted' }] });

    const result = await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V3, 'my favourite colour is burnt orange', { conversationId: 'c-remembered' }),
      acts,
    );

    expect(result.outcome).toBe('ok');
    const saved = await acts.conversations.get('user-1', 'c-remembered');
    expect(saved?.messages.map((one) => [one.role, one.content])).toEqual([
      ['user', 'my favourite colour is burnt orange'],
      ['assistant', 'burnt orange, noted'],
    ]);
  });

  it('reads the earlier turn back on the next run, so the model sees the thread', async () => {
    const conversations = inMemoryConversations();

    await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V3, 'my favourite colour is burnt orange', { conversationId: 'c-thread' }),
      activities({ script: [{ content: 'noted' }], conversations }),
    );

    const second = activities({ script: [{ content: 'burnt orange' }], conversations });
    await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V3, 'what was it again?', { conversationId: 'c-thread' }),
      second,
    );

    expect(second.seen[0]!.map((one) => one.content)).toEqual([
      'my favourite colour is burnt orange',
      'noted',
      'what was it again?',
    ]);
  });

  it('keeps each owner’s conversation to themselves across the boundary', async () => {
    const conversations = inMemoryConversations();
    await conversations.save({
      id: 'c-theirs', ownerId: 'somebody-else', title: 'Theirs',
      messages: [{ role: 'user', content: 'private', at: 'x' }], createdAt: 'x', updatedAt: 'x',
    } as never);

    const acts = activities({ script: [{ content: 'nothing to go on' }], conversations });
    await runWorkflow(input('koala', INTERACTIVE_CHAT_V3, 'what do you know?', { conversationId: 'c-theirs' }), acts);

    expect(acts.seen[0]!.map((one) => one.content)).toEqual(['what do you know?']);
  });
});

describe('when the model call fails', () => {
  it('is retried by Temporal, because the node says it is idempotent', async () => {
    const acts = activities({
      script: [new Error('Model stream error: Chat completion aborted.'), { content: 'second attempt got through' }],
    });

    const result = await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V3, 'try me', { conversationId: 'c-retried' }),
      acts,
    );

    expect(result.outcome).toBe('ok');
    expect(acts.seen.length).toBeGreaterThan(1);
    const saved = await acts.conversations.get('user-1', 'c-retried');
    expect(saved?.messages.at(-1)?.content).toBe('second attempt got through');
  });
});
