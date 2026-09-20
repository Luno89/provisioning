import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  executeChild,
} from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import {
  BUILT_IN_GROUPS,
  WORKFLOW_IMPLEMENTATIONS,
  builtInCatalogue,
  createNodeExecutor,
  createOrchestrationNodes,
  runProcedure,
  stepImplementation,
  valueImplementation,
  type ChildOutcomeValue,
  type NodeExecutor,
  type NodeImplementation,
  type NodeRequest,
  type NodeTrace,
  type OrchestrationPorts,
  type StepResult,
  type ValueResult,
} from '@koala/agent-engine/procedure';
import { createEventBus, type EngineEvent } from '@koala/agent-engine/workflow';
import {
  DEFAULT_STREAM_TASK_QUEUE,
  deviceQueue,
  handleFor,
  launchFor,
  ticketFor,
  type AgentRunOutcome,
  type ProcedureRunInput,
  type PublishArgs,
  type RecordTracesArgs,
  type SettleClaimsArgs,
  type RemoteNodeRequest,
  type RemoteNodeResult,
  type ResolveAgentArgs,
  type ResolvedAgentInfo,
  type ToolCallArgs,
  type ToolCallOutcome,
} from '../engine-host/temporal/contracts.js';
import type { RunLimits, RunLimitsArgs } from '../engine-host/registries/effort.js';
import { ASK_CHARS, type RunEffort } from '@koala/agent-engine/procedure';

const NODE_HEARTBEAT_TIMEOUT = '1 minute';

interface EngineRemote {
  EngineNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
}

interface StreamRemote {
  EngineStreamNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
}

const engine = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes' });
const engineNodes = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT });
const engineNodesOnce = proxyActivities<EngineRemote>({ retry: { maximumAttempts: 1 }, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT });
const stream = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT });
const streamOnce = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: { maximumAttempts: 1 }, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT });

const { EngineRecordTracesActivity, EngineRunLimitsActivity, EngineRecordEffortActivity, EngineSettleClaimsActivity } = proxyActivities<{
  EngineRecordTracesActivity(args: RecordTracesArgs): Promise<void>;
  EngineRunLimitsActivity(args: RunLimitsArgs): Promise<RunLimits>;
  EngineRecordEffortActivity(effort: RunEffort): Promise<void>;
  EngineSettleClaimsActivity(args: SettleClaimsArgs): Promise<string[]>;
}>({
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: '1 minute',
});

const { EnginePublishActivity } = proxyActivities<{ EnginePublishActivity(args: PublishArgs): Promise<void> }>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: '1 minute',
});

export const approveSignal = defineSignal<[{ callId: string; allowed: boolean; forRun?: boolean }]>('approve');
export const answerSignal = defineSignal<[{ nodeId: string; value: unknown }]>('answer');
export const cancelSignal = defineSignal<[]>('cancelRun');
export const stateQuery = defineQuery<{ nodeId?: string; rounds: number }>('runState');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toRemote = (request: NodeRequest): RemoteNodeRequest => ({
  node: request.node,
  origin: request.origin,
  inputs: request.inputs,
  ...(request.previous ? { previous: { ...request.previous } } : {}),
  execution: request.execution,
  run: {
    identity: request.run.identity,
    launch: request.run.launch,
    handles: request.run.handles,
    inputs: request.run.inputs,
    counters: { ...request.run.counters },
    budget: request.run.budget,
    cleaningUp: request.run.cleaningUp,
  },
});

export async function AgentRunWorkflow(input: ProcedureRunInput): Promise<AgentRunOutcome> {
  const { ticket, procedure } = input;
  const catalogue = builtInCatalogue();

  const approvals = new Map<string, boolean>();
  const answers = new Map<string, unknown>();
  let approvedForRun = false;
  let cancelled = false;
  let currentNode: string | undefined;
  let rounds = 0;
  let children = 0;

  setHandler(approveSignal, ({ callId, allowed, forRun }) => {
    approvals.set(callId, allowed);
    if (allowed && forRun) approvedForRun = true;
  });
  setHandler(answerSignal, ({ nodeId, value }) => { answers.set(nodeId, value); });
  setHandler(cancelSignal, () => { cancelled = true; });
  setHandler(stateQuery, () => ({ ...(currentNode ? { nodeId: currentNode } : {}), rounds }));

  const pending: EngineEvent[] = [];
  const traces: NodeTrace[] = [];
  const bus = createEventBus({ retain: 0 });
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    if (event.type === 'node.entered') currentNode = event.nodeId;
    pending.push(event);
  });

  const flush = async (): Promise<void> => {
    if (pending.length > 0) await EnginePublishActivity({ events: pending.splice(0, pending.length) });
    if (traces.length > 0) {
      await EngineRecordTracesActivity({
        ownerId: ticket.ownerId,
        runId: ticket.runId,
        agentSlug: ticket.agentSlug,
        procedureId: procedure.id,
        procedureVersion: procedure.version,
        traces: traces.splice(0, traces.length),
      });
    }
  };

  const publishNow = async (event: Omit<EngineEvent, 'runId' | 'at'>): Promise<void> => {
    bus.emit({ ...event, runId: ticket.runId, at: new Date(Date.now()).toISOString() } as EngineEvent);
    await flush();
  };

  const ports: OrchestrationPorts = {
    async runTool({ nodeId, call, persona, environment, run }) {
      const handle = handleFor(environment);
      const args: ToolCallArgs = {
        ticket: ticketFor(run),
        nodeId,
        name: call.name,
        arguments: call.arguments,
        callId: call.id,
        granted: persona.tools,
        ...(handle ? { environment: handle } : {}),
      };

      if (environment?.kind === 'machine') {
        const onDevice = proxyActivities<Pick<EngineRemote, 'EngineToolActivity'>>({
          taskQueue: deviceQueue(environment.deviceId),
          retry: ACTIVITY_RETRY,
          startToCloseTimeout: '30 minutes',
          scheduleToStartTimeout: '1 hour',
        });
        return onDevice.EngineToolActivity(args);
      }

      return engine.EngineToolActivity(args);
    },

    async runChild({ agent, inputs, run }): Promise<ChildOutcomeValue> {
      children += 1;
      const childRunId = `${ticket.runId}-${agent}-${children}`;
      const resolved = await engine.EngineResolveAgentActivity({ ownerId: ticket.ownerId, agentSlug: agent });

      if (!resolved.found || !resolved.procedure) {
        return { runId: childRunId, agentId: agent, outcome: 'failed', reason: `there is no agent called "${agent}"`, outputs: {} };
      }

      const child = await executeChild(AgentRunWorkflow, {
        workflowId: childRunId,
        args: [{
          ticket: {
            ...ticketFor(run),
            runId: childRunId,
            parentRunId: ticket.runId,
            depth: ticket.depth + 1,
            agentSlug: agent,
            trigger: 'agent',
          },
          procedure: resolved.procedure,
          inputs: { ...inputs, message: JSON.stringify(inputs) },
          ...(input.projectId ? { projectId: input.projectId } : {}),
        }],
      });

      return {
        runId: child.runId,
        agentId: agent,
        outcome: child.outcome,
        ...(child.reason ? { reason: child.reason } : {}),
        outputs: child.outputs,
      };
    },

    async approve({ nodeId, call, environment }) {
      if (approvedForRun) return true;

      const where = environment?.kind === 'machine' ? environment.deviceName : 'this run';
      await publishNow({
        type: 'notice',
        level: 'warn',
        nodeId,
        message: `${ticket.agentSlug} wants to run ${call.name} on ${where}: ${call.arguments}`,
      } as never);

      const decided = await condition(() => approvals.has(call.id) || cancelled, '1 day');
      if (cancelled || !decided) return false;
      return approvals.get(call.id) === true;
    },

    async ask({ nodeId, timeoutMs }) {
      await flush();
      const answered = await condition(() => answers.has(nodeId) || cancelled, timeoutMs);
      if (cancelled) return { answered: false, reason: 'the run was cancelled' };
      if (!answered) return { answered: false, reason: 'nobody answered in time' };
      return { answered: true, value: answers.get(nodeId) };
    },
  };

  const remote: NodeImplementation[] = catalogue.list()
    .filter((definition) => definition.runs === 'activity' || definition.runs === 'stream' || definition.runs === 'sandbox')
    .map((definition) => {
      const call = (request: NodeRequest): Promise<RemoteNodeResult> => {
        if (definition.runs === 'stream') {
          return (definition.idempotent ? stream : streamOnce).EngineStreamNodeActivity(toRemote(request));
        }
        return (definition.idempotent ? engineNodes : engineNodesOnce).EngineNodeActivity(toRemote(request));
      };
      return definition.role === 'step'
        ? stepImplementation(definition.kind, async (request) => (await call(request)) as StepResult)
        : valueImplementation(definition.kind, async (request) => (await call(request)) as ValueResult);
    });

  const inner = createNodeExecutor(catalogue, [
    ...WORKFLOW_IMPLEMENTATIONS,
    ...createOrchestrationNodes(ports),
    ...remote,
  ]);

  const executor: NodeExecutor = {
    async step(request) {
      const result = await inner.step(request);
      rounds = request.run.counters.rounds;
      await flush();
      return result;
    },
    value: (request) => inner.value(request),
  };

  const signal = { get aborted() { return cancelled; }, reason: 'the run was cancelled' } as AbortSignal;

  const { modelKey, modelLabel, limits } = await EngineRunLimitsActivity({
    ownerId: ticket.ownerId,
    agentSlug: ticket.agentSlug,
    procedure,
    ...(ticket.modelId ? { modelId: ticket.modelId } : {}),
  });

  const result = await runProcedure({
    procedure,
    catalogue,
    groups: BUILT_IN_GROUPS,
    executor,
    identity: {
      runId: ticket.runId,
      ...(ticket.parentRunId ? { parentRunId: ticket.parentRunId } : {}),
      depth: ticket.depth,
      agentId: ticket.agentSlug,
      loopId: procedure.id,
      loopVersion: procedure.version,
      trigger: ticket.trigger,
    },
    launch: launchFor(ticket, input.projectId),
    inputs: input.inputs,
    budget: limits,
    bus,
    signal,
    now: () => Date.now(),
    onTrace: (trace) => {
      traces.push(trace);
      bus.emit({ type: 'node.traced', runId: ticket.runId, at: new Date(Date.now()).toISOString(), nodeId: trace.node, trace: { ...trace } } as EngineEvent);
    },
  });

  await flush();

  await EngineSettleClaimsActivity({
    ownerId: ticket.ownerId,
    runId: ticket.runId,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
  });

  const ask = typeof input.inputs.message === 'string' ? input.inputs.message : JSON.stringify(input.inputs);
  await EngineRecordEffortActivity({
    runId: ticket.runId,
    ownerId: ticket.ownerId,
    ...(ticket.parentRunId ? { parentRunId: ticket.parentRunId } : {}),
    agentSlug: ticket.agentSlug,
    procedureId: procedure.id,
    procedureVersion: procedure.version,
    modelKey,
    modelLabel,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    rounds: result.counters.rounds,
    toolCalls: result.counters.toolCalls,
    totalTokens: result.counters.totalTokens,
    childRuns: result.counters.childRuns,
    longestReply: result.counters.longestReply,
    cappedAt: result.counters.cappedAt,
    steps: result.steps,
    wallClockMs: result.counters.elapsedMs,
    ask: ask.slice(0, ASK_CHARS),
    limits,
    finishedAt: new Date(Date.now()).toISOString(),
  });

  const finished = result.finishedBy ? result.outputs[result.finishedBy]?.result : undefined;
  const outputs = finished === undefined ? {} : (isRecord(finished) ? finished : { result: finished });

  return {
    runId: result.runId,
    agentId: ticket.agentSlug,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    outputs,
  };
}
