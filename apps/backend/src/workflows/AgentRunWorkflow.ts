import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  startChild,
  getExternalWorkflowHandle,
  CancellationScope,
  ActivityCancellationType,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import { childInputs } from '../engine-host/nodes/child-inputs.js';
import {
  WORKFLOW_IMPLEMENTATIONS,
  createNodeExecutor,
  createOrchestrationNodes,
  definitionFor,
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
  type RunContinuation,
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
import { RUN_STATE_QUERY, type RunState } from '../engine-host/temporal/run-cancellation.js';
import { ASK_CHARS, type RunEffort } from '@koala/agent-engine/procedure';
import { platformCatalogue, platformGroups } from '../extensions/installed.js';

const NODE_HEARTBEAT_TIMEOUT = '1 minute';
export const CONTINUE_AFTER_EVENTS = 10_000;
export const MAX_CHECKPOINT_BYTES = 1_500_000;

interface EngineRemote {
  EngineNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
  EngineResolveAgentActivity(args: ResolveAgentArgs): Promise<ResolvedAgentInfo>;
  EngineToolActivity(args: ToolCallArgs): Promise<ToolCallOutcome>;
}

interface StreamRemote {
  EngineStreamNodeActivity(request: RemoteNodeRequest): Promise<RemoteNodeResult>;
}

const ABANDON = ActivityCancellationType.ABANDON;
const engine = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes', cancellationType: ABANDON });
const engineNodes = proxyActivities<EngineRemote>({ retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT, cancellationType: ABANDON });
const engineNodesOnce = proxyActivities<EngineRemote>({ retry: { maximumAttempts: 1 }, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT, cancellationType: ABANDON });
const stream = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: ACTIVITY_RETRY, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT, cancellationType: ABANDON });
const streamOnce = proxyActivities<StreamRemote>({ taskQueue: DEFAULT_STREAM_TASK_QUEUE, retry: { maximumAttempts: 1 }, startToCloseTimeout: '30 minutes', heartbeatTimeout: NODE_HEARTBEAT_TIMEOUT, cancellationType: ABANDON });

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
export const stateQuery = defineQuery<RunState>(RUN_STATE_QUERY);

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
  const catalogue = platformCatalogue();

  const { continued } = input;
  const approvals = new Map<string, boolean>(continued?.approvals ?? []);
  const answers = new Map<string, unknown>(continued?.answers ?? []);
  let approvedForRun = continued?.approvedForRun ?? false;
  let cancelled = false;
  let currentNode: string | undefined;
  let rounds = continued?.checkpoint.counters.rounds ?? 0;
  let children = continued?.children ?? 0;
  let tooBigToContinue = false;

  setHandler(approveSignal, ({ callId, allowed, forRun }) => {
    approvals.set(callId, allowed);
    if (allowed && forRun) approvedForRun = true;
  });
  setHandler(answerSignal, ({ nodeId, value }) => { answers.set(nodeId, value); });
  const inFlight = new Set<CancellationScope>();
  const runningChildren = new Set<string>();
  const cancelRun = () => {
    if (cancelled) return;
    cancelled = true;
    for (const childId of runningChildren) {
      void getExternalWorkflowHandle(childId).signal(cancelSignal).catch(() => undefined);
    }
  };
  void condition(() => cancelled).then(() => {
    for (const scope of inFlight) scope.cancel();
  });
  const cancellable = async <T>(work: () => Promise<T>): Promise<T> => {
    const scope = new CancellationScope();
    inFlight.add(scope);
    try {
      return await scope.run(work);
    } finally {
      inFlight.delete(scope);
    }
  };
  setHandler(cancelSignal, cancelRun);
  CancellationScope.current().cancelRequested.catch(cancelRun);
  setHandler(stateQuery, () => ({ ...(currentNode ? { nodeId: currentNode } : {}), rounds, cancelled }));

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
          cancellationType: ABANDON,
          taskQueue: deviceQueue(environment.deviceId),
          retry: ACTIVITY_RETRY,
          startToCloseTimeout: '30 minutes',
          scheduleToStartTimeout: '1 hour',
        });
        return cancellable(() => onDevice.EngineToolActivity(args));
      }

      return cancellable(() => engine.EngineToolActivity(args));
    },

    async runChild({ agent, inputs, environment, run }): Promise<ChildOutcomeValue> {
      children += 1;
      const childRunId = `${ticket.runId}-${agent}-${children}`;
      const resolved = await engine.EngineResolveAgentActivity({ ownerId: ticket.ownerId, agentSlug: agent });

      if (!resolved.found || !resolved.procedure) {
        return { runId: childRunId, agentId: agent, outcome: 'failed', reason: `there is no agent called "${agent}"`, outputs: {} };
      }

      if (cancelled) return { runId: childRunId, agentId: agent, outcome: 'interrupted', reason: 'the run was cancelled', outputs: {} };

      const started = await startChild(AgentRunWorkflow, {
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
          inputs: childInputs(inputs),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(environment ? { environment } : {}),
          ...(input.continueAfterEvents ? { continueAfterEvents: input.continueAfterEvents } : {}),
        }],
      });
      runningChildren.add(childRunId);
      if (cancelled) await started.signal(cancelSignal);
      const child = await started.result().finally(() => runningChildren.delete(childRunId));

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
        const retryable = (definitionFor(catalogue, request.node) ?? definition).idempotent;
        if (definition.runs === 'stream') {
          return cancellable(() => (retryable ? stream : streamOnce).EngineStreamNodeActivity(toRemote(request)));
        }
        return cancellable(() => (retryable ? engineNodes : engineNodesOnce).EngineNodeActivity(toRemote(request)));
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

  return CancellationScope.nonCancellable(async () => {
    const resolvedLimits = continued?.limits ?? await EngineRunLimitsActivity({
      ownerId: ticket.ownerId,
      agentSlug: ticket.agentSlug,
      procedure,
      ...(ticket.modelId ? { modelId: ticket.modelId } : {}),
    });
    const { modelKey, modelLabel, limits } = resolvedLimits;
    const continueAfter = input.continueAfterEvents ?? CONTINUE_AFTER_EVENTS;

    const pauseWhen = (checkpoint: () => import('@koala/agent-engine/procedure').RunCheckpoint): boolean => {
      if (cancelled || tooBigToContinue) return false;
      const info = workflowInfo();
      if (!info.continueAsNewSuggested && info.historyLength < continueAfter) return false;
      if (JSON.stringify(checkpoint()).length <= MAX_CHECKPOINT_BYTES) return true;
      tooBigToContinue = true;
      bus.emit({
        type: 'notice',
        level: 'warn',
        runId: ticket.runId,
        at: new Date(Date.now()).toISOString(),
        message: `this run's state is over ${MAX_CHECKPOINT_BYTES} bytes, so it cannot continue as a new run and will run on in this one`,
      } as EngineEvent);
      return false;
    };

    const result = await runProcedure({
      procedure,
      catalogue,
      groups: platformGroups(),
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
      launch: { ...launchFor(ticket, input.projectId), ...(input.environment ? { environment: input.environment } : {}) },
      inputs: input.inputs,
      budget: limits,
      bus,
      signal,
      ...(continued ? { resume: continued.checkpoint } : {}),
      pauseWhen,
      now: () => Date.now(),
      onTrace: (trace) => {
        traces.push(trace);
        bus.emit({ type: 'node.traced', runId: ticket.runId, at: new Date(Date.now()).toISOString(), nodeId: trace.node, trace: { ...trace } } as EngineEvent);
      },
    });

    await flush();

    if (result.paused) {
      const next: RunContinuation = {
        checkpoint: result.paused,
        limits: resolvedLimits,
        children,
        approvedForRun,
        approvals: [...approvals],
        answers: [...answers],
        segment: (continued?.segment ?? 0) + 1,
      };
      return continueAsNew<typeof AgentRunWorkflow>({ ...input, continued: next });
    }

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
  });
}
