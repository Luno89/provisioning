import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createCompactContextNode } from '../engine-host/nodes/model-nodes.js';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { WorkflowClient, type WorkflowHandle, type WorkflowHandleWithFirstExecutionRunId } from '@temporalio/client';
import { Worker } from '@temporalio/worker';
import { dirname, resolve } from 'path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'url';
import type { ModelProvider } from '@koala/agent-engine';
import {
  PROCEDURE_SCHEMA,
  REFUSED_CALL,
  RESEARCH_V2,
  TOOL_ROUNDS_V2,
  DO_ONE_TASK_V2,
  INTERACTIVE_CHAT_V4,
  replyExit,
  stepImplementation,
  type ChatMessage,
  type ModelReply,
  type Procedure,
} from '@koala/agent-engine/procedure';
import { AgentRunWorkflow, answerSignal, approveSignal, cancelSignal, stateQuery } from './AgentRunWorkflow.js';
import { createEngineActivities, createNodeRunner } from '../engine-host/temporal/activities.js';
import { createEnvironmentResolver } from '../engine-host/sandboxes/environments.js';
import { createRunEnvironments } from '../engine-host/sandboxes/run-environments.js';
import { createMachineWorkspaces } from '../engine-host/sandboxes/machine-workspaces.js';
import { createConversationWorkspaces, type ConversationWorkspaces } from '../engine-host/sandboxes/conversation-workspaces.js';
import { runCancelledVia } from '../engine-host/temporal/run-cancellation.js';
import { createAgentRegistry } from '../engine-host/registries/registry.js';
import { BUILDER_TOOLS, contractsFor } from '@koala/agent-engine';
import { WORKSPACE_TOOLS } from '../engine-host/tools/workspace-tools-catalogue.js';
import { extensionTools, seededAgents } from '../extensions/seeds.js';
import { createEffortTracker, type RunLimitsArgs } from '../engine-host/registries/effort.js';
import { type RunEffort } from '@koala/agent-engine/procedure';
import { createHostNodes, hostNodesFor } from '../engine-host/nodes/index.js';
import { inMemoryConversations } from '../engine-host/nodes/conversation-nodes.js';
import { temporal } from '@temporalio/proto';
import type { DataConverter } from '@temporalio/common';
import { buildDataConverter } from '../lib/temporal-codec.js';
import { inMemoryPayloadBlobs } from '../lib/payload-storage.js';
import { loadKeys } from '../lib/keys.js';
import { PAPER_WRITING } from '../extensions/grove/procedures.js';
import { timeSkippingTestEnvironment } from './temporal-test-env.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { ExternalAgentStepArgs, MachineGitOp, MachineGitResult } from '@koala/engine-core';
import { createMachineGit } from '../../../local-agent/src/machine-git.js';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync as readNow } from 'node:fs';
import { ExternalAgentSessions, TOOLS_LINE, WAIT_FOR } from '../../../local-agent/src/external-agents.js';
import { LocalMcpServer } from '../../../local-agent/src/local-mcp.js';
import type { AgentScript } from '../../../local-agent/src/acp-script-agent.js';
import { EXTERNAL_AGENT_CHAT, EXTERNAL_AGENT_TASK } from '../extensions/external-agents/procedures.js';
import { payloadRingOver, remoteBlobs, type AskingSocket } from '../../../local-agent/src/remote-blobs.js';
import { machinePayloads } from '../lib/machine-payloads.js';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  type ProcedureRunInput,
  type PublishArgs,
  type LifecycleEvent,
  type RecordTracesArgs,
  type RunEnvironment,
  type RunTicket,
  type ToolCallArgs,
} from '../engine-host/temporal/contracts.js';

const noSummaries = { resolveBaseUrl: async () => { throw new Error('nothing in this test outgrows its window'); } } as never;

const __dirname = dirname(fileURLToPath(import.meta.url));

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await timeSkippingTestEnvironment();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

type Scripted = Partial<ModelReply> | Error | 'hang';

const MACHINE: RunEnvironment = { kind: 'machine', deviceId: 'desk', deviceName: 'Desk', path: 'projects/thing', egressMode: 'declared' };

function activities(options: {
  script: Scripted[];
  environment?: RunEnvironment;
  history?: RunEffort[];
  conversations?: ReturnType<typeof inMemoryConversations>;
  environments?: { describe: (ticket: RunTicket) => Promise<RunEnvironment>; release: (runId: string) => Promise<void> };
  conversationWorkspaces?: ConversationWorkspaces;
  registry?: ReturnType<typeof createAgentRegistry>;
  external?: ExternalAgentSessions;
  machineWork?: Record<string, (...args: never[]) => Promise<unknown>>;
  machineGit?: (op: MachineGitOp) => Promise<MachineGitResult>;
  memories?: unknown[];
}) {
  const registry = options.registry ?? createAgentRegistry();
  const conversations = options.conversations ?? inMemoryConversations();
  const seen: ChatMessage[][] = [];
  const aborted: string[] = [];
  let turn = 0;
  const launched: { runId: string; modelId?: string | undefined }[] = [];

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
    environments: options.environments ?? { describe: async () => options.environment ?? { kind: 'none', egress: false }, release: async () => undefined },
    memories: { list: async () => (options.memories ?? []) as never[], save: async () => undefined },
    ...(options.conversationWorkspaces ? { conversationWorkspaces: options.conversationWorkspaces } : {}),
  }), ['activity', 'sandbox']);

  const scriptedModel = stepImplementation('call-model', async ({ node, execution, inputs, run }) => {
    seen.push(structuredClone(inputs.messages as ChatMessage[]));
    launched.push({ runId: run.identity.runId, modelId: run.launch.modelId });
    const next = options.script[Math.min(turn, options.script.length - 1)]!;
    turn += 1;
    if (next instanceof Error) throw next;
    if (next === 'hang') {
      return new Promise<never>((_, reject) => {
        run.signal?.addEventListener('abort', () => {
          aborted.push(run.identity.runId);
          reject(new Error('the model call was aborted'));
        });
      });
    }

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
    launched,
    aborted,
    efforts,
    conversations,
    engine: {
      EngineRunLimitsActivity: vi.fn((args: RunLimitsArgs) => tracker.limits(args)),
      EngineRecordEffortActivity: vi.fn((effort: RunEffort) => tracker.record(effort)),
      EngineSettleClaimsActivity: vi.fn(async (_args: { ownerId: string; runId: string; outcome: string }) => [] as string[]),
      EngineToolAllowedActivity: vi.fn(async (_args: { ownerId: string; conversationId: string; tool: string }) => false),
      EngineAutoModeActivity: vi.fn(async (_args: { ownerId: string; agentSlug: string; conversationId?: string; workspaceRunId?: string }) => false),
      EngineNodeActivity: createNodeRunner(hostNodes, undefined),
      EngineResolveAgentActivity: vi.fn(createEngineActivities({ registry } as never).EngineResolveAgentActivity),
      EngineToolActivity: vi.fn(async (args: ToolCallArgs) => ({ ok: true, digest: `ran ${args.name}`, content: `output of ${args.name}` })),
      EngineRecordTracesActivity: vi.fn(async (_args: RecordTracesArgs) => undefined),
      EngineMachineNameActivity: vi.fn(createEngineActivities({ machineName: async (_ownerId: string, deviceId: string) => (deviceId === 'desk' ? 'Desk' : undefined) } as never).EngineMachineNameActivity),
      ...(options.machineWork ?? {}),
    },
    device: options.external ? {
      ExternalAgentActivity: (args: ExternalAgentStepArgs) => options.external!.step(args),
      ...(options.machineGit ? { MachineGitActivity: options.machineGit } : {}),
    } : {},
    stream: {
      EngineStreamNodeActivity: createNodeRunner([scriptedModel, createCompactContextNode({ models: noSummaries })], undefined, { runCancelled: runCancelledVia(async () => env.client) }),
      EnginePublishActivity: vi.fn(async (_args: PublishArgs) => undefined),
      EngineLifecycleActivity: vi.fn(async (_event: LifecycleEvent) => undefined),
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
  drive?: (handle: WorkflowHandle) => Promise<void>,
  dataConverter?: DataConverter,
  deviceConverter?: DataConverter,
) {
  const taskQueue = `engine-test-${Math.random().toString(36).slice(2, 8)}`;
  const converted = dataConverter ? { dataConverter } : {};
  const engineWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: resolve(__dirname, 'AgentRunWorkflow.ts'),
    activities: acts.engine,
    ...converted,
  });
  const streamWorker = await Worker.create({ connection: env.nativeConnection, taskQueue: DEFAULT_STREAM_TASK_QUEUE, activities: acts.stream, ...converted });
  const deviceWorker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: 'device-desk',
    activities: { EngineToolActivity: acts.engine.EngineToolActivity, ...acts.device },
    ...(deviceConverter ? { dataConverter: deviceConverter } : converted),
  });

  const client = drive || dataConverter ? new WorkflowClient({ connection: env.connection, ...converted }) : env.client.workflow;
  const start = async () => {
    const handle = await client.start(AgentRunWorkflow, { args: [args], taskQueue, workflowId: args.ticket.runId });
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

const delegating = (agent: string, inputs = '{"question":"why"}'): Procedure => ({
  schema: PROCEDURE_SCHEMA,
  id: 'hands-off',
  version: '1',
  name: 'Hands off',
  describe: 'delegates',
  budget: { maxRounds: 2 },
  start: 'handOff',
  nodes: [
    place('handOff', 'delegate', { agent, inputs }),
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

    let waitedOn: string[] | undefined;
    const result = await runWorkflow(input('executor', TOOL_ROUNDS_V2), acts, async (handle) => {
      while (!(await handle.query(stateQuery)).asking) await new Promise((resolve) => setTimeout(resolve, 50));
      waitedOn = (await handle.query(stateQuery)).asking;
      await handle.signal(approveSignal, { callId: 'c1', allowed: true });
    });

    expect(waitedOn).toEqual(['c1']);
    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(published(acts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool.called', callId: 'c1' }),
      expect.objectContaining({ type: 'notice', level: 'warn', callId: 'c1', tool: 'run_command', message: expect.stringContaining('run_command on Desk') }),
    ]));
  }, 60_000);

  it('does not ask when the run\'s agent or tree is in auto mode, even on someone\'s machine', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"ls"}'), { content: 'done' }] });
    acts.engine.EngineAutoModeActivity.mockImplementation(async ({ agentSlug }) => agentSlug === 'executor');
    const asked = input('executor', TOOL_ROUNDS_V2);

    const result = await runWorkflow({ ...asked, ticket: { ...asked.ticket, conversationId: 'chat-1' } }, acts);

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineAutoModeActivity).toHaveBeenCalledWith({ ownerId: asked.ticket.ownerId, agentSlug: 'executor', conversationId: 'chat-1' });
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(published(acts)).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', level: 'warn' })]));
  }, 60_000);

  it('does not ask again for a tool the person already allowed in this conversation', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"ls"}'), { content: 'done' }] });
    acts.engine.EngineToolAllowedActivity.mockImplementation(async ({ tool }) => tool === 'run_command');
    const asked = input('executor', TOOL_ROUNDS_V2);

    const result = await runWorkflow({ ...asked, ticket: { ...asked.ticket, conversationId: 'chat-1' } }, acts);

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolAllowedActivity).toHaveBeenCalledWith({ ownerId: asked.ticket.ownerId, conversationId: 'chat-1', tool: 'run_command' });
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(published(acts)).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', level: 'warn' })]));
  }, 60_000);

  it('runs a destructive call inside its sandbox without asking anyone', async () => {
    const sandbox: RunEnvironment = {
      kind: 'sandbox',
      id: 'engine-tree-t1',
      workspace: {
        runId: 'tree-t1', ownerId: 'user-1', agent: 'executor', image: 'koala/base', provides: ['git'],
        lifetimeMs: 60_000, cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared', repository: 'the project\'s repository',
      },
      capabilities: { kind: 'sandbox', lifecycle: 'persistent', languages: ['node20'] },
    };
    const registry = createAgentRegistry({
      agentStore: { list: async () => seededAgents().map((agent) => (agent.slug === 'executor' ? { ...agent, tools: [...agent.tools, 'delete_file'] } : agent)) },
      toolCatalogue: { list: async () => contractsFor([...BUILDER_TOOLS, ...WORKSPACE_TOOLS]) },
    });
    const acts = activities({ registry, environment: sandbox, script: [callsATool('c1', 'delete_file', '{"path":"stale.spec.ts"}'), { content: 'done' }] });

    const result = await runWorkflow(input('executor', TOOL_ROUNDS_V2), acts);

    expect(result.outcome).toBe('ok');
    expect(acts.engine.EngineToolActivity).toHaveBeenCalledTimes(1);
    expect(acts.engine.EngineAutoModeActivity).not.toHaveBeenCalled();
    expect(published(acts)).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', level: 'warn' })]));
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

  it('waits for a person however long they take when the step sets no time of its own', async () => {
    const patient: Procedure = { ...WAITING, nodes: WAITING.nodes.map((node) => (node.id === 'ask' ? { ...node, settings: { prompt: 'Which database?' } } : node)) };
    const acts = activities({ script: [{ content: 'unused' }] });

    const result = await runWorkflow(input('koala', patient), acts, async (handle) => {
      await env.sleep('8 days');
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'the staging one' });
    });

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'the staging one' } });
  }, 60_000);

  it('takes only one of the answers it offered, and goes on waiting through any other', async () => {
    const choosing: Procedure = { ...WAITING, nodes: WAITING.nodes.map((node) => (node.id === 'ask' ? { ...node, settings: { ...node.settings, choices: ['Install it', 'Do not install'] } } : node)) };
    const acts = activities({ script: [{ content: 'unused' }] });

    const result = await runWorkflow(input('koala', choosing), acts, async (handle) => {
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'rm -rf /' });
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'Do not install' });
    });

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'Do not install' } });
    expect(published(acts)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'notice', message: 'Which database?', choices: ['Install it', 'Do not install'] })]));
  }, 60_000);

  it('asks again when the procedure comes back to the same question, rather than reusing the answer it already took', async () => {
    const asking: Procedure = {
      ...WAITING,
      nodes: [
        place('ask', 'wait-for-person', { prompt: 'Run the tests again?', choices: ['Again', 'Done'] }),
        place('again', 'condition', { expression: "value == 'Again'" }),
        place('done', 'finish', { outcome: 'ok' }),
        place('gaveUp', 'finish', { outcome: 'failed' }),
      ],
      wires: [...WAITING.wires, { from: { node: 'ask', socket: 'answer' }, to: { node: 'again', socket: 'value' } }],
      flow: [{ from: 'ask', exit: 'answered', to: 'again' }, { from: 'again', exit: 'true', to: 'ask' }, { from: 'again', exit: 'false', to: 'done' }, { from: 'ask', exit: 'unanswered', to: 'gaveUp' }],
    };
    const acts = activities({ script: [{ content: 'unused' }] });

    const result = await runWorkflow(input('koala', asking), acts, async (handle) => {
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'Again' });
      await env.sleep('1 hour');
      await handle.signal(answerSignal, { nodeId: 'ask', value: 'Done' });
    });

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'Done' } });
    expect(published(acts).filter((event) => (event as { message?: string }).message === 'Run the tests again?')).toHaveLength(2);
  }, 60_000);

  it('gives up only when the step itself set how long to wait, and nobody answered in that time', async () => {
    const result = await runWorkflow(input('koala', WAITING), activities({ script: [{ content: 'unused' }] }));

    expect(result).toMatchObject({ outcome: 'failed', reason: 'nobody answered in the time this step waits' });
  }, 60_000);

  it('ends interrupted and hands its claimed tasks back when Temporal cancels it, as a removal does', async () => {
    const acts = activities({ script: [{ content: 'unused' }] });
    const result = await runWorkflow(input('koala', WAITING), acts, async (handle) => {
      await handle.cancel();
    });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'the run was cancelled' });
    expect(acts.engine.EngineSettleClaimsActivity).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'interrupted' }));
  }, 60_000);

  it('stops a waiting run when it is cancelled', async () => {
    const result = await runWorkflow(input('koala', WAITING), activities({ script: [{ content: 'unused' }] }), async (handle) => {
      await handle.signal(cancelSignal);
    });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'the run was cancelled' });
  }, 60_000);

  it('cancelling a run stops the model call in flight in its delegated child, and both end interrupted', async () => {
    const acts = activities({ script: ['hang'] });
    const args = input('koala', delegating('research'));

    const result = await runWorkflow(args, acts, async (handle) => {
      const deadline = Date.now() + 20_000;
      while (acts.seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await handle.signal(cancelSignal);
    });

    expect(result).toMatchObject({ outcome: 'interrupted', reason: 'the run was cancelled' });
    expect(acts.aborted).toEqual([`${args.ticket.runId}-research-1`]);
    const child = await new WorkflowClient({ connection: env.connection }).getHandle(`${args.ticket.runId}-research-1`).result();
    expect(child).toMatchObject({ outcome: 'interrupted', reason: 'the run was cancelled' });
  }, 60_000);

  it('tells the backend when a chat turn starts and when each run ends, with what it needs to decide what to remember', async () => {
    const acts = activities({ script: [{ content: 'Noted.' }] });
    const args = input('research', RESEARCH_V2, 'We use Cloudflare.', { conversationId: 'conv-9' });

    await runWorkflow(args, acts);

    expect(acts.stream.EngineLifecycleActivity.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'run-started', ownerId: 'user-1', runId: args.ticket.runId, agentSlug: 'research', depth: 0, conversationId: 'conv-9' },
      { kind: 'run-ended', ownerId: 'user-1', runId: args.ticket.runId, agentSlug: 'research', outcome: 'ok', ask: 'We use Cloudflare.', depth: 0, conversationId: 'conv-9' },
    ]);
  }, 60_000);

  it('runs a delegated persona as a child workflow on that persona\'s own procedure', async () => {
    const acts = activities({ script: [{ content: 'because it was' }] });

    const result = await runWorkflow(input('koala', delegating('research')), acts);

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'because it was' } });
    expect(acts.engine.EngineResolveAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ agentSlug: 'research' }));
    expect(acts.seen[0]![0]).toEqual({ role: 'user', content: 'question: why' });
  }, 60_000);

  describe('how far a chat\'s machine reaches', () => {
    const AGENT_SCRIPT = fileURLToPath(new URL('../../../local-agent/src/acp-script-agent.ts', import.meta.url));
    const handsOffFromItsEnvironment = (agent: string): Procedure => ({
      schema: PROCEDURE_SCHEMA,
      id: 'hands-off-provisioned',
      version: '1',
      name: 'Hands off from where it works',
      describe: 'provisions, then delegates',
      budget: { maxRounds: 2 },
      start: 'provision',
      nodes: [
        place('provision', 'provision-sandbox', {}),
        place('handOff', 'delegate', { agent, inputs: '{"question":"What port does TabbyAPI listen on?"}' }),
        place('done', 'finish', { outcome: 'ok' }),
        place('failed', 'finish', { outcome: 'failed' }),
      ],
      wires: [
        { from: { node: 'provision', socket: 'environment' }, to: { node: 'handOff', socket: 'environment' } },
        { from: { node: 'handOff', socket: 'outputs' }, to: { node: 'done', socket: 'result' } },
        { from: { node: 'handOff', socket: 'reason' }, to: { node: 'failed', socket: 'reason' } },
        { from: { node: 'provision', socket: 'reason' }, to: { node: 'failed', socket: 'reason' } },
      ],
      flow: [
        { from: 'provision', exit: 'ready', to: 'handOff' },
        { from: 'provision', exit: 'unavailable', to: 'failed' },
        { from: 'handOff', exit: 'ok', to: 'done' },
        { from: 'handOff', exit: 'failed', to: 'failed' },
      ],
      groups: [],
    });

    const onMachine = async (reach?: 'chat' | 'handoffs') => {
      const here = await mkdtemp(resolve(tmpdir(), 'external-run-'));
      const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
      const bare = resolve(here, 'gitea', 'research.git');
      const documents = resolve(here, 'pod', 'work');
      execFileSync('mkdir', ['-p', bare, documents]);
      git(bare, 'init', '-q', '--bare');
      const told = resolve(here, 'told.json');
      const scriptPath = resolve(here, 'script.json');
      await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [
        { record: told },
        { mcp: { server: 'koala', tool: 'search_web', args: { query: 'TabbyAPI default port' } } },
        { tool: { id: 'ls', title: 'ls', kind: 'execute' }, ask: true, output: 'tabby.md' },
        { write: { path: 'tabby.md', content: 'TabbyAPI listens on 5000.\n' } },
        { say: 'Found it on the machine.' },
      ] }] } satisfies AgentScript));
      const mcp = new LocalMcpServer();
      await mcp.start();
      const machineRoot = resolve(here, 'machine');
      const sessions = new ExternalAgentSessions({ rootDir: machineRoot, launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT_SCRIPT, scriptPath] } }, segmentMs: 500, mcp });
      const registry = createAgentRegistry({ toolCatalogue: { list: async () => contractsFor([...BUILDER_TOOLS, ...extensionTools()]) } });
      const resolver = createEnvironmentResolver({
        registry,
        environments: createRunEnvironments({ provision: async () => { throw new Error('nothing in this test starts a pod'); } }),
        images: { ensure: async (plan) => plan.base, exists: async () => true, start: async (plan) => ({ state: 'ready' as const, reference: plan.base }), standing: async (plan) => ({ state: 'ready' as const, reference: plan.base }) },
        tools: async () => [],
        workspaces: createMachineWorkspaces({ list: async () => [{ id: 'desk', ownerId: 'user-1', name: 'Desk' }] }),
      });
      const saved: string[] = [];
      const conversationWorkspaces = createConversationWorkspaces({
        resolver,
        registry,
        kube: async () => { throw new Error('nothing in this test reaches the cluster'); },
        documents: { save: async (request: { workspaceRunId: string; repo: string }) => { saved.push(request.workspaceRunId); return { saved: true, owner: 'koala-user-1', repo: request.repo, commit: git(documents, 'rev-parse', 'HEAD') }; } } as never,
      });
      const sent: { workspaceRunId: string; worktree?: string; start?: unknown }[] = [];
      const acts = activities({
        registry,
        script: [{ content: 'Found it with the model.' }],
        external: sessions,
        environments: resolver,
        conversationWorkspaces,
        machineWork: {
          EngineMachineSendActivity: async (args: { workspaceRunId: string; worktree?: string; branch: string; message: string; start?: unknown }) => {
            sent.push(args);
            if (!existsSync(resolve(documents, '.git'))) git(documents, 'init', '-q', '-b', 'main');
            git(documents, 'add', '-A');
            git(documents, 'commit', '-q', '--allow-empty', '-m', args.message);
            git(documents, 'push', '-q', bare, `HEAD:refs/heads/${args.branch}`);
            return { repo: 'research-c1', folder: '/work', commit: git(documents, 'rev-parse', 'HEAD') };
          },
          EngineMachineTakeActivity: async (args: { branch: string }) => {
            git(documents, 'fetch', '-q', bare, `+refs/heads/${args.branch}:refs/koala/machine`);
            git(documents, 'merge', '-q', '--ff-only', 'refs/koala/machine');
            return { brought: true, commit: git(documents, 'rev-parse', 'HEAD') };
          },
          EngineMachineDropActivity: async (args: { branch: string }) => { git(bare, 'branch', '-D', args.branch); },
        },
        machineGit: createMachineGit({ rootDir: machineRoot, backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare }),
      });
      acts.engine.EngineAutoModeActivity.mockImplementation(async (args: { conversationId?: string }) => args.conversationId === 'c1');
      try {
        const args = input('koala', handsOffFromItsEnvironment('research'));
        const result = await runWorkflow({ ...args, ticket: { ...args.ticket, conversationId: 'c1', modelId: 'machine:desk:antigravity', ...(reach ? { modelReach: reach } : {}) } }, acts);
        const recorded = existsSync(told) ? JSON.parse(await readFile(told, 'utf8')) as { cwd: string; prompt: string; servers: { server: string; tools: { name: string }[] }[] } : undefined;
        return {
          result,
          recorded,
          machineRoot,
          sent,
          saved,
          brought: existsSync(resolve(documents, 'tabby.md')) ? await readFile(resolve(documents, 'tabby.md'), 'utf8') : undefined,
          resolved: acts.engine.EngineResolveAgentActivity.mock.calls.map(([call]) => call),
          toolCalls: acts.engine.EngineToolActivity.mock.calls.map(([call]) => call),
          unaskedFor: acts.engine.EngineAutoModeActivity.mock.calls.map(([call]) => call),
        };
      } finally {
        await sessions.closeAll();
        await mcp.close();
        await rm(here, { recursive: true, force: true });
      }
    };

    it('runs research a chat on a machine hands work to on that machine, in the conversation\'s workspace, its served tools there and its work brought back', async () => {
      const { result, recorded, machineRoot, sent, saved, brought, resolved, toolCalls, unaskedFor } = await onMachine();

      expect(result).toMatchObject({ outcome: 'ok' });
      expect(JSON.stringify(result.outputs)).toContain('Found it on the machine.');
      expect(resolved).toContainEqual(expect.objectContaining({ agentSlug: 'research', modelId: 'machine:desk:antigravity', handedDown: true }));
      expect(sent).toEqual([expect.objectContaining({
        workspaceRunId: 'conversation-c1',
        start: {
          ticket: expect.objectContaining({ agentSlug: 'research', inPlace: true }),
          environment: expect.objectContaining({ id: expect.stringContaining('conversation-c1'), workspace: expect.objectContaining({ runId: 'conversation-c1' }) }),
        },
      })]);
      expect(recorded?.cwd).toBe(resolve(machineRoot, 'koala-trees', 'conversation-c1', 'repo'));
      expect(recorded?.prompt).toContain('is a checkout of this conversation\'s documents, from its workspace in Koala');
      expect(recorded?.servers.find((server) => server.server === 'koala')?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['search_web', 'run_in_workspace']));
      const search = toolCalls.find((call) => call.name === 'search_web');
      expect(search?.environment).toMatchObject({ workspace: { runId: 'conversation-c1', sharedBy: 'conversation', repository: 'this conversation\'s documents' } });
      expect(search?.ticket).toMatchObject({ agentSlug: 'research', inPlace: true, conversationId: 'c1' });
      expect(unaskedFor).toContainEqual(expect.objectContaining({ agentSlug: 'research', conversationId: 'c1' }));
      expect(brought).toBe('TabbyAPI listens on 5000.\n');
      expect(saved).toEqual(['conversation-c1']);
    }, 60_000);

    it('leaves the agents it hands work to on their own models when the machine is for this chat only, in the conversation\'s workspace', async () => {
      const { result, resolved, sent, recorded } = await onMachine('chat');

      expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'Found it with the model.' } });
      expect(resolved.find((call) => call.agentSlug === 'research')).not.toHaveProperty('modelId');
      expect(sent).toEqual([]);
      expect(recorded).toBeUndefined();
    }, 60_000);
  });

  it('hands a delegated persona the opening line its parent wrote, and still labels the rest of what it was given', async () => {
    const acts = activities({ script: [{ content: 'because it was' }] });

    const result = await runWorkflow(
      input('koala', delegating('research', '{"question":"why","message":"Answer this one question."}')),
      acts,
    );

    expect(result).toMatchObject({ outcome: 'ok' });
    expect(acts.seen[0]![0]).toEqual({ role: 'user', content: 'Answer this one question.\n\nquestion: why' });
  }, 60_000);

  it('hands a delegated persona the sandbox its caller works in, across the child workflow, and only the caller releases it', async () => {
    const sandbox: RunEnvironment = {
      kind: 'sandbox',
      id: 'engine-parent',
      workspace: {
        runId: 'parent', ownerId: 'user-1', agent: 'koala', image: 'koala/base', provides: ['git', 'node'],
        lifetimeMs: 60_000, cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared',
      },
      capabilities: { kind: 'sandbox', lifecycle: 'invocation', languages: ['node20'] },
    };
    const environments = {
      describe: vi.fn(async (_ticket: RunTicket) => sandbox),
      release: vi.fn(async (_runId: string) => undefined),
    };
    const acts = activities({
      environments,
      script: [
        callsATool('c1', 'research', '{"question":"why"}'),
        callsATool('c2', 'search_web', '{"query":"why"}'),
        { content: 'because it was' },
        { content: 'done' },
      ],
    });

    const args = input('koala', TOOL_ROUNDS_V2);
    const result = await runWorkflow(args, acts);

    expect(result).toMatchObject({ outcome: 'ok' });
    expect(environments.describe).toHaveBeenCalledTimes(1);
    expect(environments.describe.mock.calls[0]![0].runId).toBe(args.ticket.runId);

    const childCall = acts.engine.EngineToolActivity.mock.calls.map(([call]) => call).find((call) => call.name === 'search_web');
    expect(childCall?.ticket.parentRunId).toBe(args.ticket.runId);
    expect(childCall?.environment?.id).toBe('engine-parent');

    expect(environments.release.mock.calls.map(([runId]) => runId)).toEqual([args.ticket.runId]);
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

describe('a long run continues as a new one', () => {
  const twiceDelegating: Procedure = {
    schema: PROCEDURE_SCHEMA,
    id: 'hands-off-twice',
    version: '1',
    name: 'Hands off twice',
    describe: 'delegates two times in a row',
    budget: { maxRounds: 4 },
    start: 'first',
    nodes: [
      place('first', 'delegate', { agent: 'research', inputs: '{"question":"one"}' }),
      place('second', 'delegate', { agent: 'research', inputs: '{"question":"two"}' }),
      place('done', 'finish', { outcome: 'ok' }),
      place('failed', 'finish', { outcome: 'failed' }),
    ],
    wires: [
      { from: { node: 'second', socket: 'outputs' }, to: { node: 'done', socket: 'result' } },
      { from: { node: 'second', socket: 'reason' }, to: { node: 'failed', socket: 'reason' } },
    ],
    flow: [
      { from: 'first', exit: 'ok', to: 'second' },
      { from: 'first', exit: 'failed', to: 'failed' },
      { from: 'second', exit: 'ok', to: 'done' },
      { from: 'second', exit: 'failed', to: 'failed' },
    ],
    groups: [],
  };

  it('carries its tool rounds across every new run and ends with the same answer, settled and recorded once', async () => {
    const acts = activities({ script: [
      callsATool('c1', 'read_file', '{"path":"a"}'),
      callsATool('c2', 'read_file', '{"path":"b"}'),
      callsATool('c3', 'read_file', '{"path":"c"}'),
      { content: 'a, b and c all say hello' },
    ] });
    const args = { ...input('executor', TOOL_ROUNDS_V2), continueAfterEvents: 1 };
    let firstRun = '';

    const result = await runWorkflow(args, acts, async (handle) => { firstRun = (handle as WorkflowHandleWithFirstExecutionRunId).firstExecutionRunId; });

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'a, b and c all say hello' } });
    const first = await env.client.workflow.getHandle(args.ticket.runId, firstRun).describe();
    expect(first.status.name).toBe('CONTINUED_AS_NEW');
    expect(acts.engine.EngineToolActivity.mock.calls.map(([call]) => call.callId)).toEqual(['c1', 'c2', 'c3']);
    const lastTurn = acts.seen.at(-1)!;
    expect(lastTurn.filter((message) => message.role === 'tool').map((message) => (message as { toolCallId?: string }).toolCallId)).toEqual(['c1', 'c2', 'c3']);
    expect(acts.engine.EngineRunLimitsActivity).toHaveBeenCalledTimes(1);
    expect(acts.engine.EngineSettleClaimsActivity).toHaveBeenCalledTimes(1);
    expect(acts.efforts.filter((effort) => effort.runId === args.ticket.runId)).toHaveLength(1);
    expect(published(acts).filter((event) => event.type === 'run.started' && event.runId === args.ticket.runId)).toHaveLength(1);
  }, 120_000);

  it('answers with everything it and the runs it handed work to made, across a new run', async () => {
    const findings = { kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r1/findings.md' };
    const notes = { kind: 'file' as const, workspace: 'conversation-c1', path: 'koala/notes.md' };
    const acts = activities({ script: [
      callsATool('c1', 'research', '{"question":"why"}'),
      callsATool('c2', 'write_file', '{"path":"research/r1/findings.md"}'),
      { content: 'it is in findings.md' },
      callsATool('c3', 'write_file', '{"path":"koala/notes.md"}'),
      { content: 'done' },
    ] });
    acts.engine.EngineToolActivity.mockImplementation(async (args: ToolCallArgs) => ({
      ok: true,
      digest: `ran ${args.name}`,
      content: '',
      artifacts: [args.callId === 'c2' ? findings : notes],
    }));
    const args = { ...input('koala', TOOL_ROUNDS_V2), continueAfterEvents: 1 };

    const result = await runWorkflow(args, acts);

    expect(result).toMatchObject({ outcome: 'ok' });
    expect(result.artifacts).toEqual([findings, notes]);
  }, 120_000);

  it('answers with every step it took, each hand-off\'s run nested under the call that started it, across a new run', async () => {
    const findings = { kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r1/findings.md' };
    const acts = activities({ script: [
      callsATool('c1', 'research', '{"question":"why"}'),
      callsATool('c2', 'write_file', '{"path":"research/r1/findings.md"}'),
      { content: 'it is in findings.md' },
      callsATool('c3', 'read_file', '{"path":"research/r1/findings.md"}'),
      { content: 'done' },
    ] });
    acts.engine.EngineToolActivity.mockImplementation(async (args: ToolCallArgs) => ({
      ok: true,
      digest: `ran ${args.name}`,
      content: '',
      ...(args.callId === 'c2' ? { artifacts: [findings] } : {}),
    }));
    const args = { ...input('koala', TOOL_ROUNDS_V2), continueAfterEvents: 1 };

    const result = await runWorkflow(args, acts);

    const childRunId = `${args.ticket.runId}-research-1`;
    expect(result.steps).toEqual([
      {
        callId: 'c1', name: 'research', ok: true, digest: expect.any(String), artifacts: [findings],
        child: { runId: childRunId, agentId: 'research', outcome: 'ok', steps: [{ callId: 'c2', name: 'write_file', ok: true, digest: 'ran write_file', artifacts: [findings] }] },
      },
      { callId: 'c3', name: 'read_file', ok: true, digest: 'ran read_file' },
    ]);
    expect(published(acts).find((event) => event.type === 'run.started' && event.runId === childRunId)).toMatchObject({ parentRunId: args.ticket.runId, parentCallId: 'c1' });
  }, 120_000);

  it('keeps numbering its children across a new run, so no child reuses an earlier one\'s id', async () => {
    const acts = activities({ script: [{ content: 'one answered' }, { content: 'two answered' }] });
    const args = { ...input('koala', twiceDelegating), continueAfterEvents: 1 };

    const result = await runWorkflow(args, acts);

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'two answered' } });
    const childRuns = acts.efforts.map((effort) => effort.runId).filter((id) => id !== args.ticket.runId).sort();
    expect(childRuns).toEqual([`${args.ticket.runId}-research-1`, `${args.ticket.runId}-research-2`]);
  }, 120_000);

  it('does not continue while its history is short', async () => {
    const acts = activities({ script: [{ content: 'The answer is 42.' }] });
    const args = input('research', RESEARCH_V2);
    let firstRun = '';

    await runWorkflow(args, acts, async (handle) => { firstRun = (handle as WorkflowHandleWithFirstExecutionRunId).firstExecutionRunId; });

    expect((await env.client.workflow.getHandle(args.ticket.runId, firstRun).describe()).status.name).toBe('COMPLETED');
  }, 60_000);
});

describe('a writer whose reply is cut off', () => {
  it('carries on from what it already wrote instead of ending, and the run answers with the rest', async () => {
    const acts = activities({ script: [
      { content: '# The paper\n\nPart one, cut off mid', finishReason: 'length' },
      { content: 'Part two, finished.' },
    ] });

    const result = await runWorkflow(input('paper-writer', PAPER_WRITING), acts);

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'Part two, finished.' } });
    const second = acts.seen[1]!;
    expect(second.some((message) => message.role === 'assistant' && String(message.content).includes('Part one, cut off mid'))).toBe(true);
  }, 60_000);

  it('fails a writer that ends saying nothing, rather than letting it claim a paper it did not write', async () => {
    const acts = activities({ script: [{ content: '' }] });

    const result = await runWorkflow(input('paper-writer', PAPER_WRITING), acts);

    expect(result).toMatchObject({ outcome: 'failed', reason: 'the writer ended without saying anything' });
  }, 60_000);
});

describe('a run bigger than Temporal can carry', () => {
  const page = () => randomBytes(800_000).toString('base64');

  const historyOf = async (workflowId: string, firstRunId: string) => {
    const sizes: number[] = [];
    let runId: string | undefined = firstRunId;
    while (runId) {
      const history = await env.client.workflow.getHandle(workflowId, runId).fetchHistory();
      let next: string | undefined;
      for (const event of history.events ?? []) {
        sizes.push(temporal.api.history.v1.HistoryEvent.encode(event).finish().length);
        next = event.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId ?? next;
      }
      runId = next;
    }
    return sizes;
  };

  it('keeps every event small however large the conversation grows, across continue-as-new, by storing big payloads outside Temporal', async () => {
    const acts = activities({ script: [
      callsATool('c1', 'fetch', '{"url":"a"}'),
      callsATool('c2', 'fetch', '{"url":"b"}'),
      callsATool('c3', 'fetch', '{"url":"c"}'),
      { content: 'three pages read' },
    ] });
    acts.engine.EngineToolActivity.mockImplementation(async (call: ToolCallArgs) => ({ ok: true, digest: `fetched ${call.callId}`, content: `${call.callId}: ${page()}` }));
    const blobs = inMemoryPayloadBlobs();
    const converter = buildDataConverter(loadKeys({ JWT_SECRET: 'payload-storage-test' }).payload, blobs);
    const args = { ...input('executor', TOOL_ROUNDS_V2), continueAfterEvents: 1 };
    let firstRun = '';

    const result = await runWorkflow(args, acts, async (handle) => { firstRun = (handle as WorkflowHandleWithFirstExecutionRunId).firstExecutionRunId; }, converter);

    expect(result).toMatchObject({ outcome: 'ok', outputs: { result: 'three pages read' } });
    const sizes = await historyOf(args.ticket.runId, firstRun);
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.max(...sizes)).toBeLessThan(512 * 1024);
    expect(Math.max(...[...blobs.stored.values()].map((blob) => blob.data.length))).toBeGreaterThan(3_000_000);
    expect(blobs.stored.size).toBeGreaterThan(0);
    expect([...blobs.stored.values()].every((blob) => blob.workflowId === args.ticket.runId)).toBe(true);
  }, 180_000);
});

describe('a remembered conversation, through the workflow', () => {
  it('writes the turn across the activity boundary, not just in process', async () => {
    const acts = activities({ script: [{ content: 'burnt orange, noted' }] });

    const result = await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V4, 'my favourite colour is burnt orange', { conversationId: 'c-remembered' }),
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
      input('koala', INTERACTIVE_CHAT_V4, 'my favourite colour is burnt orange', { conversationId: 'c-thread' }),
      activities({ script: [{ content: 'noted' }], conversations }),
    );

    const second = activities({ script: [{ content: 'burnt orange' }], conversations });
    await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V4, 'what was it again?', { conversationId: 'c-thread' }),
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
    await runWorkflow(input('koala', INTERACTIVE_CHAT_V4, 'what do you know?', { conversationId: 'c-theirs' }), acts);

    expect(acts.seen[0]!.map((one) => one.content)).toEqual(['what do you know?']);
  });

  it('remembers a declined call with the refusal kind, not an empty failure and not nothing at all', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"rm -rf /"}'), { content: 'understood' }] });

    const result = await runWorkflow(
      input('executor', INTERACTIVE_CHAT_V4, 'run the thing', { conversationId: 'c-declined' }),
      acts,
      async (handle) => { await handle.signal(approveSignal, { callId: 'c1', allowed: false }); },
    );

    expect(result.outcome).toBe('ok');
    const saved = await acts.conversations.get('user-1', 'c-declined');
    expect(saved?.messages.map((one) => [one.role, one.content])).toEqual([
      ['user', 'run the thing'],
      ['assistant', 'understood'],
    ]);
    expect(saved?.messages.at(-1)?.toolCalls).toEqual([
      { id: 'c1', name: 'run_command', args: '{"command":"rm -rf /"}', ok: false, digest: REFUSED_CALL },
    ]);
  }, 60_000);

  it('remembers the calls a turn made in the middle of its rounds, with what they gave back', async () => {
    const acts = activities({ environment: MACHINE, script: [callsATool('c1', 'run_command', '{"command":"ls"}'), { content: 'it listed fine' }] });

    const result = await runWorkflow(
      input('executor', INTERACTIVE_CHAT_V4, 'run the thing', { conversationId: 'c-released' }),
      acts,
      async (handle) => { await handle.signal(approveSignal, { callId: 'c1', allowed: true }); },
    );

    expect(result.outcome).toBe('ok');
    const saved = await acts.conversations.get('user-1', 'c-released');
    expect(saved?.messages.map((one) => [one.role, one.content])).toEqual([
      ['user', 'run the thing'],
      ['assistant', 'it listed fine'],
    ]);
    expect(saved?.messages.at(-1)?.toolCalls).toEqual([
      { id: 'c1', name: 'run_command', args: '{"command":"ls"}', ok: true, digest: 'output of run_command' },
    ]);
  }, 60_000);
});

describe('when the model call fails', () => {
  it('is retried by Temporal, because the node says it is idempotent', async () => {
    const acts = activities({
      script: [new Error('Model stream error: Chat completion aborted.'), { content: 'second attempt got through' }],
    });

    const result = await runWorkflow(
      input('koala', INTERACTIVE_CHAT_V4, 'try me', { conversationId: 'c-retried' }),
      acts,
    );

    expect(result.outcome).toBe('ok');
    expect(acts.seen.length).toBeGreaterThan(1);
    const saved = await acts.conversations.get('user-1', 'c-retried');
    expect(saved?.messages.at(-1)?.content).toBe('second attempt got through');
  });
});


const EXTERNAL: Procedure = {
  schema: PROCEDURE_SCHEMA,
  id: 'external',
  version: '1',
  name: 'External',
  describe: 'hands the task to an agent on the machine',
  budget: { maxRounds: 2 },
  start: 'agent',
  nodes: [
    place('input', 'run-input', {}),
    place('agent', 'external-agent', { agent: 'scripted' }),
    place('done', 'finish', { outcome: 'ok' }),
    place('stopped', 'finish', { outcome: 'failed' }),
    place('failed', 'finish', { outcome: 'failed' }),
  ],
  wires: [
    { from: { node: 'input', socket: 'message' }, to: { node: 'agent', socket: 'brief' } },
    { from: { node: 'agent', socket: 'text' }, to: { node: 'done', socket: 'result' } },
    { from: { node: 'agent', socket: 'reason' }, to: { node: 'stopped', socket: 'reason' } },
    { from: { node: 'agent', socket: 'reason' }, to: { node: 'failed', socket: 'reason' } },
  ],
  flow: [{ from: 'agent', exit: 'finished', to: 'done' }, { from: 'agent', exit: 'stopped', to: 'stopped' }, { from: 'agent', exit: 'failed', to: 'failed' }],
  groups: [],
};

describe('an external agent working on someone\'s machine', () => {
  const AGENT = fileURLToPath(new URL('../../../local-agent/src/acp-script-agent.ts', import.meta.url));
  let root: string;

  const machine = async (script: AgentScript) => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify(script));
    return new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { scripted: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
  };

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('hands it the task in the run\'s folder, asks the person before what it wants permission for, and ends with its reply', async () => {
    const sessions = await machine({ name: 'scripted', version: '3.1', turns: [{ steps: [
      { think: 'Plan: write, then push.' },
      { write: { path: 'labels.py', content: 'print("labels")\n' } },
      { tool: { id: 'push', title: 'git push', kind: 'execute' }, ask: true, output: 'pushed' },
      { say: 'Wrote and pushed the labels.' },
    ] }] });
    const acts = activities({ script: [{ content: 'unused' }], external: sessions });

    let waitedOn: string[] | undefined;
    const result = await runWorkflow({ ...input('executor', EXTERNAL, 'Write the labels'), environment: MACHINE }, acts, async (handle) => {
      while (!(await handle.query(stateQuery)).asking) await new Promise((wait) => setTimeout(wait, 50));
      waitedOn = (await handle.query(stateQuery)).asking;
      await handle.signal(approveSignal, { callId: 'ext-push', allowed: true });
    });

    expect(waitedOn).toEqual(['ext-push']);
    expect(result.outcome).toBe('ok');
    expect(result.outputs.result).toBe('Wrote and pushed the labels.');
    expect(sessions.openKeys()).toEqual([]);
    expect(await readFile(resolve(root, 'machine', 'projects/thing', 'labels.py'), 'utf8')).toBe('print("labels")\n');
    expect(published(acts)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'thinking', nodeId: 'agent', delta: 'Plan: write, then push.' }),
      expect.objectContaining({ type: 'notice', level: 'warn', callId: 'ext-push', tool: 'scripted.execute', message: 'executor wants to run scripted.execute on Desk: git push' }),
      expect.objectContaining({ type: 'tool.called', callId: 'ext-push', name: 'scripted.execute', args: 'git push' }),
      expect.objectContaining({ type: 'tool.result', callId: 'ext-push', ok: true, digest: 'pushed' }),
      expect.objectContaining({ type: 'content', nodeId: 'agent', delta: 'Wrote and pushed the labels.' }),
    ]));
    await sessions.closeAll();
  }, 60_000);

  it('tells the agent no when the person declines, and the agent carries on without it', async () => {
    const sessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [
      { tool: { id: 'wipe', title: 'rm -rf build', kind: 'delete' }, ask: true },
      { say: 'Left the build alone.' },
    ] }] });
    const acts = activities({ script: [{ content: 'unused' }], external: sessions });

    const result = await runWorkflow({ ...input('executor', EXTERNAL, 'Clean up'), environment: MACHINE }, acts, async (handle) => {
      while (!(await handle.query(stateQuery)).asking) await new Promise((wait) => setTimeout(wait, 50));
      await handle.signal(approveSignal, { callId: 'ext-wipe', allowed: false });
    });

    expect(result.outcome).toBe('ok');
    expect(result.outputs.result).toBe('Left the build alone.');
    expect(published(acts)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool.result', callId: 'ext-wipe', ok: false, digest: 'the person declined' })]));
    await sessions.closeAll();
  }, 60_000);

  it('stops the agent\'s turn when the run is cancelled, and closes its session', async () => {
    const sessions = await machine({ name: 'scripted', version: '1', turns: [{ steps: [{ say: 'Starting a long job.' }, { wait: 120_000 }, { say: 'never' }] }] });
    const acts = activities({ script: [{ content: 'unused' }], external: sessions });

    const result = await runWorkflow({ ...input('executor', EXTERNAL, 'Do the long job'), environment: MACHINE }, acts, async (handle) => {
      await new Promise((wait) => setTimeout(wait, 1500));
      await handle.signal(cancelSignal);
    });

    expect(result.outcome).toBe('interrupted');
    expect(sessions.openKeys()).toEqual([]);
    expect(published(acts)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'content', delta: 'Starting a long job.' })]));
  }, 60_000);

  it('runs the shipped procedure as the Antigravity agent: the machine\'s antigravity is told its prompt and folder once, then given the task', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [{ echo: true }] }] } satisfies AgentScript));
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
    const acts = activities({ script: [{ content: 'unused' }], external: sessions, environment: MACHINE });

    const result = await runWorkflow(input('antigravity', EXTERNAL_AGENT_TASK, 'Build the delivery labels.'), acts);

    expect(result.outcome).toBe('ok');
    const told = String(result.outputs.result);
    expect(told).toMatch(/^Your folder is .*machine\/projects\/thing\./);
    expect(told).toContain('You are working for Koala');
    expect(told.endsWith('Build the delivery labels.')).toBe(true);
    expect(sessions.openKeys()).toEqual([]);
  }, 60_000);

  it('answers a chat turn with the agent picked on a machine, and the next turn continues the same session', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [{ echo: true }] }] } satisfies AgentScript));
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
    const conversations = inMemoryConversations();
    const acts = activities({ script: [{ content: 'unused' }], external: sessions, environment: MACHINE, conversations });
    const turn = (message: string): ProcedureRunInput => ({
      ticket: { ...ticket('koala'), conversationId: 'c-ext', modelId: 'machine:desk:antigravity' },
      procedure: EXTERNAL_AGENT_CHAT,
      inputs: { message, conversationId: 'c-ext' },
    });

    const first = await runWorkflow(turn('What is in the labels module?'), acts);
    expect(first.outcome).toBe('ok');
    expect(String(first.outputs.result)).toContain((await createAgentRegistry().agent('user-1', 'koala'))!.prompt.slice(0, 60));
    expect(String(first.outputs.result).endsWith('What is in the labels module?')).toBe(true);

    const second = await runWorkflow(turn('And the tests?'), acts);
    expect(second.outcome).toBe('ok');
    expect(second.outputs.result).toBe('And the tests?');

    const stored = await conversations.get('user-1', 'c-ext');
    expect(stored?.machineSessions).toEqual({ 'desk:antigravity': 'scripted-1' });
    expect(stored?.messages.map((message) => [message.role, message.content.slice(-14)])).toEqual([
      ['user', 'labels module?'], ['assistant', 'labels module?'], ['user', 'And the tests?'], ['assistant', 'And the tests?'],
    ]);
    expect(sessions.openKeys()).toEqual([]);
  }, 60_000);

  it('keeps what the agent thought and the tools it called with its reply, so the turn still shows them once it ends', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [
      { think: 'Look at the tree first.' },
      { tool: { id: 'ls', title: 'ls addons', kind: 'read' }, output: 'delivery_labels' },
      { say: 'There is one module.' },
    ] }] } satisfies AgentScript));
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
    const conversations = inMemoryConversations();
    const acts = activities({ script: [{ content: 'unused' }], external: sessions, environment: MACHINE, conversations });

    const result = await runWorkflow({
      ticket: { ...ticket('koala'), conversationId: 'c-kept', modelId: 'machine:desk:antigravity' },
      procedure: EXTERNAL_AGENT_CHAT,
      inputs: { message: 'What modules are there?', conversationId: 'c-kept' },
    }, acts);

    expect(result.outcome).toBe('ok');
    const reply = (await conversations.get('user-1', 'c-kept'))?.messages.at(-1);
    expect(reply).toMatchObject({
      role: 'assistant',
      content: 'There is one module.',
      reasoning: 'Look at the tree first.',
      toolCalls: [{ id: 'ext-ls', name: 'antigravity.read', args: 'ls addons', ok: true, digest: 'delivery_labels' }],
    });
    await sessions.closeAll();
  }, 60_000);

  it('works a story\'s folder on the machine: checks it out there, brings its work in before run_in_workspace, and brings it back when the turn ends', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
    const bare = resolve(root, 'gitea', 'tree.git');
    const folder = resolve(root, 'pod', 'trees', 'l1');
    execFileSync('mkdir', ['-p', bare, folder]);
    git(bare, 'init', '-q', '--bare');
    git(folder, 'init', '-q', '-b', 'leaf/l1');
    await writeFile(resolve(folder, 'README.md'), 'labels\n');
    git(folder, 'add', '-A');
    git(folder, 'commit', '-q', '-m', 'start');
    await writeFile(resolve(folder, 'notes.md'), 'what the model left\n');

    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [
      { read: { path: 'notes.md' } },
      { tool: { id: 'ls', title: 'ls', kind: 'execute' }, ask: true, output: 'notes.md README.md' },
      { write: { path: 'label.txt', content: 'Axial Concepts\n' } },
      { mcp: { server: 'koala', tool: 'run_in_workspace', args: { command: 'cat label.txt' } } },
      { say: 'The label is in.' },
    ] }] } satisfies AgentScript));
    const mcp = new LocalMcpServer();
    await mcp.start();
    const machineRoot = resolve(root, 'machine');
    const sessions = new ExternalAgentSessions({ rootDir: machineRoot, launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
    const sandbox = {
      kind: 'sandbox',
      id: 'engine-tree-t1',
      worktree: 'trees/l1',
      workspace: {
        runId: 'tree-t1', ownerId: 'user-1', agent: 'executor', image: 'koala/base', provides: ['git'],
        lifetimeMs: 60_000, cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared', repository: 'the project\'s repository',
      },
      capabilities: { kind: 'sandbox', lifecycle: 'persistent', languages: ['node20'] },
    } as RunEnvironment;
    const dropped: string[] = [];
    const inWorkspaceWhenRun: string[] = [];
    const acts = activities({
      script: [{ content: 'a model would never be asked' }],
      external: sessions,
      environment: sandbox,
      machineWork: {
        EngineMachineSendActivity: async (args: { workspaceRunId: string; worktree?: string; branch: string; message: string }) => {
          git(folder, 'add', '-A');
          git(folder, 'commit', '-q', '-m', args.message);
          git(folder, 'push', '-q', bare, `HEAD:refs/heads/${args.branch}`);
          return { repo: 'tree', folder: `/work/${args.worktree}`, commit: git(folder, 'rev-parse', 'HEAD') };
        },
        EngineMachineTakeActivity: async (args: { branch: string }) => {
          git(folder, 'fetch', '-q', bare, `+refs/heads/${args.branch}:refs/koala/machine`);
          git(folder, 'merge', '-q', '--ff-only', 'refs/koala/machine');
          return { brought: true, commit: git(folder, 'rev-parse', 'HEAD') };
        },
        EngineMachineDropActivity: async (args: { branch: string }) => {
          dropped.push(args.branch);
          git(bare, 'branch', '-D', args.branch);
        },
      },
      machineGit: createMachineGit({ rootDir: machineRoot, backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare }),
    });
    acts.engine.EngineToolActivity.mockImplementation(async (args: ToolCallArgs) => {
      inWorkspaceWhenRun.push(`${args.name} ${args.arguments} ${existsSync(resolve(folder, 'label.txt')) ? readNow(resolve(folder, 'label.txt'), 'utf8').trim() : 'missing'}`);
      return { ok: true, digest: 'Axial Concepts', content: 'Axial Concepts\n(exit code 0)' };
    });

    try {
      const result = await runWorkflow({ ...input('executor', TOOL_ROUNDS_V2, 'Add the delivery label.'), ticket: { ...ticket('executor'), modelId: 'machine:desk:antigravity' } }, acts, async (handle) => {
        while (!(await handle.query(stateQuery)).asking?.length) await new Promise((wait) => setTimeout(wait, 50));
        await handle.signal(approveSignal, { callId: 'ext-ls', allowed: true });
      });

      expect(result.outcome).toBe('ok');
      expect(String(result.outputs.result)).toContain('The label is in.');
      expect(published(acts)).toContainEqual(expect.objectContaining({ type: 'notice', level: 'warn', callId: 'ext-ls', message: 'executor wants to run antigravity.execute on Desk: ls' }));
      expect(inWorkspaceWhenRun).toEqual(['run_command {"command":"cat label.txt"} Axial Concepts']);
      expect(readNow(resolve(folder, 'label.txt'), 'utf8')).toBe('Axial Concepts\n');
      expect(readNow(resolve(folder, 'notes.md'), 'utf8')).toBe('what the model left\n');
      expect(git(folder, 'status', '--porcelain')).toBe('');
      expect(git(folder, 'log', '--format=%s').split('\n')).toEqual(['Work so far, for run_in_workspace', 'Work so far, before antigravity on Desk takes it', 'start']);
      expect(git(folder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('leaf/l1');
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toMatch(/^machine\/desk\//);
      expect(git(bare, 'branch', '--list')).toBe('');
      expect(acts.seen).toEqual([]);
    } finally {
      await sessions.closeAll();
      await mcp.close();
    }
  }, 60_000);

  describe('what an agent on a machine is told', () => {
    const storyFolder = async (base: string) => {
      const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
      const bare = resolve(base, 'gitea', 'tree.git');
      const folder = resolve(base, 'pod', 'trees', 'l1');
      execFileSync('mkdir', ['-p', bare, folder]);
      git(bare, 'init', '-q', '--bare');
      git(folder, 'init', '-q', '-b', 'leaf/l1');
      await writeFile(resolve(folder, 'README.md'), 'labels\n');
      git(folder, 'add', '-A');
      git(folder, 'commit', '-q', '-m', 'start');
      return {
        bare,
        machineWork: {
          EngineMachineSendActivity: async (args: { worktree?: string; branch: string; message: string }) => {
            git(folder, 'add', '-A');
            git(folder, 'commit', '-q', '--allow-empty', '-m', args.message);
            git(folder, 'push', '-q', bare, `HEAD:refs/heads/${args.branch}`);
            return { repo: 'tree', folder: `/work/${args.worktree}`, commit: git(folder, 'rev-parse', 'HEAD') };
          },
          EngineMachineTakeActivity: async (args: { branch: string }) => {
            git(folder, 'fetch', '-q', bare, `+refs/heads/${args.branch}:refs/koala/machine`);
            git(folder, 'merge', '-q', '--ff-only', 'refs/koala/machine');
            return { brought: true, commit: git(folder, 'rev-parse', 'HEAD') };
          },
          EngineMachineDropActivity: async (args: { branch: string }) => { git(bare, 'branch', '-D', args.branch); },
        },
      };
    };
    const storySandbox = {
      kind: 'sandbox',
      id: 'engine-tree-t1',
      worktree: 'trees/l1',
      workspace: {
        runId: 'tree-t1', ownerId: 'user-1', agent: 'executor', image: 'koala/odoo-20', provides: ['git', 'odoo-check'],
        lifetimeMs: 60_000, cpu: '1', memory: '1Gi', egress: [], env: [], egressMode: 'declared', repository: 'the project\'s repository',
      },
      capabilities: { kind: 'sandbox', lifecycle: 'persistent', languages: ['python3'] },
    } as RunEnvironment;
    const remembered = {
      id: 'm1', ownerId: 'user-1', category: 'environment_facts', scope: 'global', recommendedScope: 'global', status: 'active',
      title: 'Odoo 20 paper formats', text: 'In Odoo 20 a report names its paper format through paperformat_id.', createdAt: 'now', updatedAt: 'now',
    };
    interface Recorded { cwd: string; prompt: string; servers: { server: string; tools: { name: string; description?: string }[] }[] }

    it('gives an executor working a story everything a model would get, the setup it works in, and every tool it is served', async () => {
      root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
      const { bare, machineWork } = await storyFolder(root);
      const told = resolve(root, 'told.json');
      const scriptPath = resolve(root, 'script.json');
      await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [
        { when: 'Question: Does this verdict', steps: [{ say: 'Yes.' }] },
        { steps: [{ record: told }, { write: { path: 'label.txt', content: 'Axial Concepts\n' } }, { say: 'Wrote label.txt.' }] },
      ] } satisfies AgentScript));
      const mcp = new LocalMcpServer();
      await mcp.start();
      const machineRoot = resolve(root, 'machine');
      const sessions = new ExternalAgentSessions({ rootDir: machineRoot, launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
      const registry = createAgentRegistry({ toolCatalogue: { list: async () => contractsFor([...BUILDER_TOOLS, ...extensionTools()]) } });
      const acts = activities({
        registry, script: [{ content: 'The work meets what was asked.' }], external: sessions, environment: storySandbox, machineWork, memories: [remembered],
        machineGit: createMachineGit({ rootDir: machineRoot, backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare }),
      });
      const task = { id: 't1', leafId: 'l1', title: 'Write the label', doneMeans: 'label.txt says Axial Concepts', checks: {} };

      try {
        const result = await runWorkflow({
          ...input('executor', DO_ONE_TASK_V2, 'Work the task Write the label.', { item: task }),
          ticket: { ...ticket('executor'), modelId: 'machine:desk:antigravity', modelReach: 'chat' },
        }, acts);
        expect(result.outcome).toBe('ok');

        const got = JSON.parse(await readFile(told, 'utf8')) as Recorded;
        const executor = seededAgents().find((agent) => agent.slug === 'executor')!;
        const said = got.prompt;
        const at = (text: string): number => {
          const found = said.indexOf(text);
          expect(found, `the agent was not told: ${text}`).toBeGreaterThanOrEqual(0);
          return found;
        };

        expect(got.cwd).toBe(resolve(machineRoot, 'koala-trees', 'tree-t1', 'trees', 'l1'));
        at(`Your folder is ${got.cwd}.`);
        at('Koala\'s tools are served to you through the MCP server named koala.');
        at(executor.prompt.slice(0, 120));
        const setup = at('HOW YOU WORK HERE');
        at('is a checkout of the folder trees/l1 of the project\'s repository');
        at('Run them with run_in_workspace');
        at('everything in your folder goes back into the workspace, committed or not');
        expect(at('YOUR EXECUTION ENVIRONMENT')).toBeGreaterThan(setup);
        at('koala/odoo-20');
        at('WHAT THE PROCEDURE DOES AROUND YOU');
        at('The task has already been claimed for you.');
        at('a judge weighs your work against what the task asked for');
        at('The outcome is then recorded on the task for you.');
        const usable = said.slice(at('TOOLS YOU CAN USE RIGHT NOW'), at('YOURS ON THIS MACHINE'));
        const listed = [...usable.matchAll(/^- ([a-z_]+): /gm)].map((match) => match[1]!).sort();
        at('Koala would give a model these tools: run_command, read_file, write_file, list_dir.');
        at('In Odoo 20 a report names its paper format through paperformat_id.');
        expect(said.split('Work the task Write the label.')).toHaveLength(2);
        expect(said).not.toContain('The conversation so far');
        expect(at('"doneMeans": "label.txt says Axial Concepts"')).toBeGreaterThan(at('When you are done, your answer must provide: summary, changed.'));

        const koala = got.servers.find((server) => server.server === 'koala');
        const served = new Map(koala?.tools.map((tool) => [tool.name, tool.description ?? '']));
        expect([...served.keys()].sort()).toEqual([...listed, WAIT_FOR].sort());
        expect(said).toContain(TOOLS_LINE);
        expect(listed).toEqual(expect.arrayContaining(['run_in_workspace', 'request_secret', 'request_egress', 'list_project_secrets']));
        expect(said).not.toContain('NOT AVAILABLE TO YOU THIS TURN\n\n- request_secret');
        expect(served.get('run_in_workspace')).toContain('Runs a shell command in the project\'s workspace');
        for (const [name, description] of served) expect(description.trim(), `${name} has no description`).not.toBe('');
      } finally {
        await sessions.closeAll();
        await mcp.close();
      }
    }, 60_000);

    it('lets the agent\'s own asks through without anyone when its tree is on auto mode', async () => {
      root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
      const { bare, machineWork } = await storyFolder(root);
      const scriptPath = resolve(root, 'script.json');
      await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [
        { steps: [{ tool: { id: 'ls', title: 'ls -la', kind: 'execute' }, ask: true, output: 'README.md' }, { say: 'Looked.' }] },
      ] } satisfies AgentScript));
      const machineRoot = resolve(root, 'machine');
      const sessions = new ExternalAgentSessions({ rootDir: machineRoot, launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
      const acts = activities({
        script: [{ content: 'unused' }], external: sessions, environment: storySandbox, machineWork,
        machineGit: createMachineGit({ rootDir: machineRoot, backendUrl: 'http://koala.test', token: 'device-token', remote: () => bare }),
      });
      acts.engine.EngineAutoModeActivity.mockImplementation(async (args: { workspaceRunId?: string }) => args.workspaceRunId === 'tree-t1');

      try {
        const result = await runWorkflow({ ...input('executor', TOOL_ROUNDS_V2, 'Look around.'), ticket: { ...ticket('executor'), modelId: 'machine:desk:antigravity' } }, acts);
        expect(result.outcome).toBe('ok');
        expect(String(result.outputs.result)).toContain('Looked.');
        expect(acts.engine.EngineAutoModeActivity).toHaveBeenCalledWith(expect.objectContaining({ workspaceRunId: 'tree-t1' }));
      } finally {
        await sessions.closeAll();
      }
    }, 60_000);

    it('tells an agent working a folder of its own that it is the project\'s own, and offers no run_in_workspace', async () => {
      root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
      const told = resolve(root, 'told.json');
      const scriptPath = resolve(root, 'script.json');
      await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [{ record: told }, { say: 'Looked.' }] }] } satisfies AgentScript));
      const mcp = new LocalMcpServer();
      await mcp.start();
      const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
      const registry = createAgentRegistry({ toolCatalogue: { list: async () => contractsFor([...BUILDER_TOOLS, ...WORKSPACE_TOOLS]) } });
      const acts = activities({ registry, script: [{ content: 'unused' }], external: sessions, environment: MACHINE });

      try {
        const result = await runWorkflow({ ...input('executor', TOOL_ROUNDS_V2, 'Look around.'), ticket: { ...ticket('executor'), modelId: 'machine:desk:antigravity' } }, acts);
        expect(result.outcome).toBe('ok');
        const got = JSON.parse(await readFile(told, 'utf8')) as Recorded;
        expect(got.prompt).toContain('That folder is the project\'s own folder on this machine; what you change there stays there.');
        expect(got.prompt).not.toContain('run_in_workspace');
        expect(got.prompt).toContain('Koala would give a model these tools: run_command, read_file, write_file, list_dir. You have your own for the same work, so use yours, in your folder.');
        expect(got.servers.find((server) => server.server === 'koala')?.tools.map((tool) => tool.name)).not.toContain('run_in_workspace');
      } finally {
        await sessions.closeAll();
        await mcp.close();
      }
    }, 60_000);
  });

  it('serves the agent its persona\'s own tools, runs each call through the run (asking before one that changes something), and starts it on the model picked', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    const models = { current: 'flash', available: [{ id: 'flash', name: 'Gemini 3.8 Flash' }, { id: 'pro', name: 'Gemini 3.8 Pro' }] };
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', models, turns: [{ steps: [
      { tellModel: true },
      { mcp: { server: 'koala', tool: 'list_references', args: {} } },
      { mcp: { server: 'koala', tool: 'save_procedure', args: { procedure: '{}' } } },
    ] }] } satisfies AgentScript));
    const mcp = new LocalMcpServer();
    await mcp.start();
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
    const conversations = inMemoryConversations();
    const registry = createAgentRegistry({
      agentStore: { list: async () => seededAgents().map((agent) => (agent.slug === 'koala' ? { ...agent, tools: ['list_references', 'save_procedure'] } : agent)) },
      toolCatalogue: { list: async () => contractsFor(BUILDER_TOOLS) },
    });
    const acts = activities({ registry, script: [{ content: 'unused' }], external: sessions, environment: MACHINE, conversations });
    let asked: string[] | undefined;
    try {
      const result = await runWorkflow({
        ticket: { ...ticket('koala'), conversationId: 'c-tools', modelId: 'machine:desk:antigravity:pro' },
        procedure: EXTERNAL_AGENT_CHAT,
        inputs: { message: 'What can you reach?', conversationId: 'c-tools' },
      }, acts, async (handle) => {
        while (!(await handle.query(stateQuery)).asking?.length) await new Promise((settle) => setTimeout(settle, 50));
        asked = (await handle.query(stateQuery)).asking;
        await handle.signal(approveSignal, { callId: asked![0]!, allowed: false });
      });

      expect(result.outcome).toBe('ok');
      const said = String(result.outputs.result);
      expect(said).toContain('on pro');
      expect(said).toContain('list_references: output of list_references');
      expect(said).toContain('save_procedure: you did not approve that call, so it did not run');
      expect(asked).toHaveLength(1);
      expect(acts.engine.EngineToolActivity.mock.calls.map(([call]) => call.name)).toEqual(['list_references']);
      const stored = await conversations.get('user-1', 'c-tools');
      expect(stored?.machineSessions).toEqual({ 'desk:antigravity:pro': 'scripted-1' });
      expect(stored?.messages.at(-1)?.toolCalls).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'list_references', ok: true, digest: expect.stringContaining('output of list_references') }),
        expect.objectContaining({ name: 'save_procedure', ok: false, digest: 'you did not approve that call, so it did not run' }),
      ]));
      expect(sessions.openKeys()).toEqual([]);
    } finally {
      await sessions.closeAll();
      await mcp.close();
    }
  }, 60_000);

  it('saves the run of an agent a served call hands work to on the chat\'s reply, so its steps are still there after the turn', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [
      { mcp: { server: 'koala', tool: 'research', args: { question: 'What port does TabbyAPI use?' } } },
      { say: 'It is 5000.' },
    ] }] } satisfies AgentScript));
    const mcp = new LocalMcpServer();
    await mcp.start();
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
    const conversations = inMemoryConversations();
    const registry = createAgentRegistry({
      agentStore: { list: async () => seededAgents().map((agent) => (agent.slug === 'koala' ? { ...agent, tools: [], agents: ['research'] } : agent)) },
      toolCatalogue: { list: async () => contractsFor(BUILDER_TOOLS) },
    });
    const acts = activities({ registry, script: [{ content: 'TabbyAPI listens on 5000.' }], external: sessions, environment: MACHINE, conversations });
    try {
      const result = await runWorkflow({
        ticket: { ...ticket('koala'), conversationId: 'c-hands', modelId: 'machine:desk:antigravity', modelReach: 'chat' },
        procedure: EXTERNAL_AGENT_CHAT,
        inputs: { message: 'Ask research.', conversationId: 'c-hands' },
      }, acts);

      expect(result.outcome).toBe('ok');
      const stored = await conversations.get('user-1', 'c-hands');
      expect(stored?.messages.at(-1)?.toolCalls).toContainEqual(expect.objectContaining({
        name: 'research',
        ok: true,
        child: expect.objectContaining({ agentId: 'research', outcome: 'ok', steps: expect.any(Array) }),
      }));
    } finally {
      await sessions.closeAll();
      await mcp.close();
    }
  }, 60_000);

  it('runs the calls an agent on a machine makes at once together, and gives it each answer', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [
      { mcp: [
        { server: 'koala', tool: 'list_references', args: { about: 'twitter' } },
        { server: 'koala', tool: 'list_references', args: { about: 'reddit' } },
      ] },
    ] }] } satisfies AgentScript));
    const mcp = new LocalMcpServer();
    await mcp.start();
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500, mcp });
    const registry = createAgentRegistry({
      agentStore: { list: async () => seededAgents().map((agent) => (agent.slug === 'koala' ? { ...agent, tools: ['list_references'] } : agent)) },
      toolCatalogue: { list: async () => contractsFor(BUILDER_TOOLS) },
    });
    const acts = activities({ registry, script: [{ content: 'unused' }], external: sessions, environment: MACHINE, conversations: inMemoryConversations() });
    let running = 0;
    let most = 0;
    acts.engine.EngineToolActivity.mockImplementation(async ({ arguments: args }: { arguments: string }) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((settle) => setTimeout(settle, 1500));
      running -= 1;
      const about = JSON.parse(args).about as string;
      return { ok: true, digest: `references about ${about}`, content: `references about ${about}` };
    });
    try {
      const result = await runWorkflow({
        ticket: { ...ticket('koala'), conversationId: 'c-together', modelId: 'machine:desk:antigravity' },
        procedure: EXTERNAL_AGENT_CHAT,
        inputs: { message: 'Look both up', conversationId: 'c-together' },
      }, acts);

      expect(result.outcome).toBe('ok');
      expect(most).toBe(2);
      const said = String(result.outputs.result);
      expect(said).toContain('list_references: references about twitter');
      expect(said).toContain('list_references: references about reddit');
    } finally {
      await sessions.closeAll();
      await mcp.close();
    }
  }, 60_000);

  it('runs on a machine that reads its instance\'s payloads: encrypted, and fetched or stored over its socket when they are large', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [{ echo: true }] }] } satisfies AgentScript));
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
    const acts = activities({ script: [{ content: 'unused' }], external: sessions, environment: MACHINE, conversations: inMemoryConversations() });
    const ring = loadKeys({ JWT_SECRET: 'machine-payloads-test' }).payload;
    const blobs = inMemoryPayloadBlobs();
    const instance = machinePayloads({ ring, blobs });
    const asked: string[] = [];
    const socket: AskingSocket = {
      connected: true,
      once: () => undefined,
      off: () => undefined,
      emit(event, payload, ack) {
        asked.push(event);
        const answer = event === 'machine:payloads' ? Promise.resolve(instance.ring()) : event === 'payloads:put' ? instance.put(payload) : instance.get(payload);
        void answer.then((value) => (ack as (answer: unknown) => void)(value));
        return true;
      },
    };
    const onMachine = buildDataConverter(await payloadRingOver(socket), remoteBlobs(socket));
    const pasted = `Read this checksum list: ${randomBytes(200_000).toString('hex')}`;

    const result = await runWorkflow({
      ticket: { ...ticket('koala'), conversationId: 'c-big', modelId: 'machine:desk:antigravity' },
      procedure: EXTERNAL_AGENT_CHAT,
      inputs: { message: pasted, conversationId: 'c-big' },
    }, acts, undefined, buildDataConverter(ring, blobs), onMachine);

    expect(result.outcome).toBe('ok');
    expect(String(result.outputs.result).endsWith(pasted)).toBe(true);
    expect(asked).toEqual(expect.arrayContaining(['machine:payloads', 'payloads:get', 'payloads:put']));
    expect(blobs.stored.size).toBeGreaterThan(1);
    await sessions.closeAll();
  }, 60_000);

  it('says in the chat why the machine could not take the turn, instead of an empty reply', async () => {
    const conversations = inMemoryConversations();
    const acts = activities({ script: [{ content: 'unused' }], environment: MACHINE, conversations });
    acts.device = { ExternalAgentActivity: async () => { throw new Error('Unknown encoding: binary/encrypted-aes-256-gcm'); } };

    const result = await runWorkflow({
      ticket: { ...ticket('koala'), conversationId: 'c-broken', modelId: 'machine:desk:antigravity' },
      procedure: EXTERNAL_AGENT_CHAT,
      inputs: { message: 'Hello?', conversationId: 'c-broken' },
    }, acts);

    expect(result.outcome).toBe('failed');
    const stored = await conversations.get('user-1', 'c-broken');
    expect(stored?.messages.at(-1)).toMatchObject({ role: 'assistant', content: '', interruptedReason: 'Desk could not run antigravity: Unknown encoding: binary/encrypted-aes-256-gcm' });
  }, 60_000);

  it('hands a story to an agent set to work on a machine, whatever model the run that handed it over used', async () => {
    root = await mkdtemp(resolve(tmpdir(), 'external-run-'));
    const scriptPath = resolve(root, 'script.json');
    await writeFile(scriptPath, JSON.stringify({ name: 'antigravity-acp', version: '1.4.0', turns: [{ steps: [{ echo: true }] }] } satisfies AgentScript));
    const sessions = new ExternalAgentSessions({ rootDir: resolve(root, 'machine'), launches: { antigravity: { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), AGENT, scriptPath] } }, segmentMs: 500 });
    const registry = createAgentRegistry({
      agentStore: { list: async () => seededAgents().map((agent) => (agent.slug === 'research' ? { ...agent, model: { endpointId: 'machine:desk:antigravity' } } : agent)) },
    });
    const acts = activities({ registry, script: [{ content: 'unused' }], external: sessions, environment: MACHINE });

    const result = await runWorkflow({ ...input('koala', delegating('research', '{"message":"Write the labels"}')), ticket: { ...ticket('koala'), modelId: 'tabby-qwen' } }, acts);

    expect(result.outcome).toBe('ok');
    expect(JSON.stringify(result.outputs)).toContain('Write the labels');
    expect(acts.engine.EngineResolveAgentActivity).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'user-1', agentSlug: 'research', modelId: 'tabby-qwen' }));
    expect(acts.seen).toEqual([]);
    expect(sessions.openKeys()).toEqual([]);
  }, 60_000);

  it('gives each agent in a tree\'s run the model the tree chose for it, or its own, never the one the run above it used', async () => {
    const chosen: Record<string, { modelId?: string }> = { 'grove-run-t1~abc': { modelId: 'vllm-big' }, 'grove-run-t2~abc': {} };
    for (const [runId, tree] of Object.entries(chosen)) {
      const acts = activities({ script: [{ content: 'because it was' }] });
      acts.engine.EngineResolveAgentActivity = vi.fn(createEngineActivities({
        registry: createAgentRegistry(),
        treeModel: async (_owner: string, turnId: string, slug: string) => (turnId === runId && slug === 'research' ? tree : undefined),
      } as never).EngineResolveAgentActivity);

      const result = await runWorkflow({ ...input('koala', delegating('research')), ticket: { ...ticket('koala'), runId, modelId: 'tabby-qwen' } }, acts);

      expect(result.outcome).toBe('ok');
      expect(acts.launched).toEqual([{ runId: `${runId}-research-1`, modelId: tree.modelId }]);
    }
  }, 60_000);

  it('fails readably when the run has no machine for it', async () => {
    const acts = activities({ script: [{ content: 'unused' }] });
    const result = await runWorkflow(input('executor', EXTERNAL, 'Do it'), acts);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('scripted works on a person\'s machine, and no machine was picked for this run');
  }, 60_000);
});
