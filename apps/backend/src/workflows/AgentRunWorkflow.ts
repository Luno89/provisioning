import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  executeChild,
  workflowInfo,
} from '@temporalio/workflow';
import { ACTIVITY_RETRY } from '../lib/activity-retry.js';
import { createEventBus } from '../engine/events.js';
import { runGraph } from '../engine/executor.js';
import { createRunState, type RunBudget, type RunIdentity, type RunResult } from '../engine/run.js';
import { createMonitorSet, repetitionMonitor, stallMonitor, toolFailureMonitor } from '../engine/monitors.js';
import type { LoopGraph } from '../engine/graph.js';
import type { EngineEvent } from '../engine/events.js';
import type { ExecutorPorts } from '../engine/executor.js';
import { deviceQueue, DEFAULT_STREAM_TASK_QUEUE } from '../engine/temporal/contracts.js';
import type {
  AgentRunOutcome,
  MergeArgs,
  ResolveEnvironmentArgs,
  RunEnvironment,
  ModelCallArgs,
  ModelCallOutcome,
  EnvironmentHandleRef,
  PublishArgs,
  ReleaseEnvironmentArgs,
  ResolveAgentArgs,
  ResolvedAgentInfo,
  RunTicket,
  ToolCallArgs,
  ToolCallOutcome,
} from '../engine/temporal/contracts.js';

const {
  EngineResolveEnvironmentActivity,
  EngineResolveAgentActivity,
  EngineToolActivity,
  EngineMergeActivity,
} = proxyActivities<{
  EngineResolveAgentActivity: (args: ResolveAgentArgs) => Promise<ResolvedAgentInfo>;
  EngineToolActivity: (args: ToolCallArgs) => Promise<ToolCallOutcome>;
  EngineMergeActivity: (args: MergeArgs) => Promise<Record<string, unknown>>;
  EngineResolveEnvironmentActivity: (args: ResolveEnvironmentArgs) => Promise<RunEnvironment>;
}>({
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
});

const { EngineReleaseEnvironmentActivity } = proxyActivities<{
  EngineReleaseEnvironmentActivity: (args: ReleaseEnvironmentArgs) => Promise<void>;
}>({
  retry: { maximumAttempts: 3 },
  startToCloseTimeout: '5 minutes',
});

const { EngineModelCallActivity, EnginePublishActivity } = proxyActivities<{
  EngineModelCallActivity: (args: ModelCallArgs) => Promise<ModelCallOutcome>;
  EnginePublishActivity: (args: PublishArgs) => Promise<void>;
}>({
  taskQueue: DEFAULT_STREAM_TASK_QUEUE,
  retry: ACTIVITY_RETRY,
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
});

export interface AgentRunInput {
  ticket: RunTicket;
  graph: LoopGraph;
  budget: RunBudget;
  messages: { role: string; content: string }[];
  inputs?: Record<string, unknown> | undefined;
  callableAgents?: string[] | undefined;
  granted?: string[] | undefined;
}

export const approveSignal = defineSignal<[{ callId: string; allowed: boolean; forRun?: boolean }]>('approve');
export const answerSignal = defineSignal<[{ nodeId: string; value: unknown }]>('answer');
export const cancelSignal = defineSignal<[]>('cancelRun');
export const stateQuery = defineQuery<{ nodeId?: string; rounds: number }>('runState');

export async function AgentRunWorkflow(input: AgentRunInput): Promise<AgentRunOutcome> {
  const { ticket, graph, budget } = input;

  const answers = new Map<string, unknown>();
  let cancelled = false;
  let currentNode: string | undefined;
  const state = createRunState(Date.now(), input.inputs ?? {});

  const approvals = new Map<string, boolean>();
  let approvedForRun = false;

  setHandler(approveSignal, ({ callId, allowed, forRun }) => {
    approvals.set(callId, allowed);
    if (allowed && forRun) approvedForRun = true;
  });

  setHandler(answerSignal, ({ nodeId, value }) => {
    answers.set(nodeId, value);
  });
  setHandler(cancelSignal, () => {
    cancelled = true;
  });
  setHandler(stateQuery, () => ({
    ...(currentNode ? { nodeId: currentNode } : {}),
    rounds: state.counters.rounds,
  }));

  const pending: EngineEvent[] = [];
  const bus = createEventBus({ retain: 0 });
  bus.subscribe((event) => {
    if (event.type === 'thinking' || event.type === 'content') return;
    if (event.type === 'node.entered') currentNode = event.nodeId;
    pending.push(event);
  });

  const identity: RunIdentity = {
    runId: ticket.runId,
    ...(ticket.parentRunId ? { parentRunId: ticket.parentRunId } : {}),
    depth: ticket.depth,
    agentId: ticket.agentSlug,
    loopId: graph.id,
    loopVersion: graph.version,
    trigger: ticket.trigger,
  };

  const messages = [...input.messages];
  const callable = new Set(input.callableAgents ?? []);
  let delegations = 0;

  const environment = await EngineResolveEnvironmentActivity({ ticket });

  const handle: EnvironmentHandleRef | undefined = environment.kind === 'sandbox'
    ? { id: environment.id, spec: environment.capabilities, workspace: environment.workspace }
    : environment.kind === 'machine'
      ? {
        id: `machine:${environment.deviceId}`,
        spec: { kind: 'machine', lifecycle: 'persistent' },
        scope: { deviceId: environment.deviceId, ...(environment.path ? { path: environment.path } : {}) },
      }
      : undefined;

  const askApproval = async (callId: string, name: string, args: string): Promise<boolean> => {
    if (environment.kind !== 'machine' || approvedForRun) return true;

    await EnginePublishActivity({
      events: [{
        type: 'notice',
        runId: ticket.runId,
        at: new Date(Date.now()).toISOString(),
        level: 'warn',
        message: `${ticket.agentSlug} wants to run ${name} on ${environment.deviceName}: ${args}`,
      }],
    });

    const decided = await condition(() => approvals.has(callId) || cancelled, '1 day');
    if (cancelled || !decided) return false;
    return approvals.get(callId) === true;
  };

  const runToolCall = async (nodeId: string, callId: string, name: string, args: string): Promise<ToolCallOutcome> => {
    if (!(await askApproval(callId, name, args))) {
      const why = cancelled ? 'the run was cancelled' : 'you did not approve that command';
      return { ok: false, digest: why, content: why };
    }

    const call: ToolCallArgs = {
      ticket,
      nodeId,
      name,
      arguments: args,
      callId,
      granted: input.granted ?? [],
      ...(handle ? { environment: handle } : {}),
    };

    if (environment.kind === 'machine') {
      const onDevice = proxyActivities<{ EngineToolActivity: (args: ToolCallArgs) => Promise<ToolCallOutcome> }>({
        taskQueue: deviceQueue(environment.deviceId),
        retry: ACTIVITY_RETRY,
        startToCloseTimeout: '30 minutes',
        scheduleToStartTimeout: '1 hour',
      });
      return onDevice.EngineToolActivity(call);
    }

    return EngineToolActivity(call);
  };

  const delegate = async (slug: string, inputs: Record<string, unknown>): Promise<AgentRunOutcome> => {
    const resolved = await EngineResolveAgentActivity({ ownerId: ticket.ownerId, agentSlug: slug });

    if (!resolved.found || !resolved.graph) {
      return {
        runId: `${ticket.runId}-${slug}-unresolved`,
        agentId: slug,
        outcome: 'failed',
        reason: `there is no agent called "${slug}"`,
        outputs: {},
      };
    }

    const childRunId = `${ticket.runId}-${slug}-${delegations++}`;

    return executeChild(AgentRunWorkflow, {
      workflowId: childRunId,
      args: [{
        ticket: {
          runId: childRunId,
          parentRunId: ticket.runId,
          depth: ticket.depth + 1,
          ownerId: ticket.ownerId,
          agentSlug: slug,
          ...(ticket.conversationId ? { conversationId: ticket.conversationId } : {}),
          trigger: 'agent' as const,
        },
        graph: resolved.graph as LoopGraph,
        budget: resolved.budget ?? {},
        messages: [{ role: 'user', content: JSON.stringify(inputs) }],
        inputs,
        callableAgents: resolved.callableAgents,
        granted: resolved.tools ?? [],
      }],
    });
  };

  const ports: ExecutorPorts = {
    async callModel({ node, state: runState }) {
      const modelNode = node as { id: string; tools?: 'granted' | 'none'; toolChoice?: 'none'; maxTokens?: number; reasoningEffort?: string };
      const outcome = await EngineModelCallActivity({
        ticket,
        nodeId: modelNode.id,
        environment,
        tools: modelNode.tools === 'none' ? 'none' : 'granted',
        ...(modelNode.toolChoice ? { toolChoice: modelNode.toolChoice } : {}),
        ...(modelNode.maxTokens ? { maxTokens: modelNode.maxTokens } : {}),
        ...(modelNode.reasoningEffort ? { reasoningEffort: modelNode.reasoningEffort } : {}),
        messages,
      });

      if (outcome.content) messages.push({ role: 'assistant', content: outcome.content });
      void runState;

      return {
        content: outcome.content,
        thinking: outcome.thinking,
        toolCalls: outcome.toolCalls,
        usage: outcome.usage,
        finishReason: outcome.finishReason,
        unsupported: [],
        interrupted: outcome.interrupted,
      };
    },

    async runTool({ node, state: runState }) {
      const toolNode = node as { id: string; tool: string; args?: Record<string, unknown> };
      const callId = `${toolNode.id}-${runState.counters.toolCalls}`;
      const outcome = await runToolCall(
        toolNode.id,
        callId,
        toolNode.tool,
        JSON.stringify(toolNode.args ?? {}),
      );
      return { ok: outcome.ok, digest: outcome.digest, callId };
    },

    async dispatchTool({ node, call }) {
      if (callable.has(call.name)) {
        let inputs: Record<string, unknown> = {};
        try {
          inputs = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          const why = `the arguments for "${call.name}" were not valid JSON`;
          messages.push({ role: 'tool', content: why });
          return { ok: false, digest: why };
        }

        const child = await delegate(call.name, inputs);
        const digest = child.outcome === 'ok'
          ? JSON.stringify(child.outputs)
          : `${call.name} did not finish: ${child.reason ?? child.outcome}`;

        messages.push({ role: 'tool', content: digest });
        return { ok: child.outcome === 'ok', digest };
      }

      const outcome = await runToolCall(
        (node as { id: string }).id,
        call.id,
        call.name,
        call.arguments,
      );
      messages.push({ role: 'tool', content: outcome.content ?? outcome.digest });
      return { ok: outcome.ok, digest: outcome.digest };
    },

    async runAgent({ agent, inputs }) {
      return delegate(agent, inputs);
    },

    async mergeChildren({ strategy, children }) {
      return EngineMergeActivity({
        ticket,
        nodeId: 'merge',
        ...(strategy ? { strategy } : {}),
        children: children.map((child) => ({
          runId: child.runId,
          agentId: child.agentId,
          outcome: child.outcome,
          outputs: child.outputs,
        })),
      });
    },

    async awaitAnswer({ node, prompt }) {
      const waitNode = node as { id: string; timeoutMs?: number };
      await EnginePublishActivity({
        events: [{
          type: 'notice',
          runId: ticket.runId,
          at: new Date(Date.now()).toISOString(),
          level: 'info',
          message: prompt,
        }],
      });

      const answered = await condition(
        () => answers.has(waitNode.id) || cancelled,
        waitNode.timeoutMs ? `${waitNode.timeoutMs}ms` : '7 days',
      );

      if (cancelled) return { answered: false, reason: 'the run was cancelled' };
      if (!answered) return { answered: false, reason: 'nobody answered in time' };

      return { answered: true, value: answers.get(waitNode.id) };
    },

    now: () => Date.now(),
  };

  const monitors = createMonitorSet([
    stallMonitor(),
    repetitionMonitor(),
    toolFailureMonitor(),
  ]);

  let result: RunResult;
  try {
    result = await runGraph({
      graph,
      identity,
      state,
      budget,
      bus,
      ports,
      monitors,
    });
  } finally {
    if (environment.kind === 'sandbox') {
      await EngineReleaseEnvironmentActivity({ ticket, environmentId: environment.id })
        .catch(() => undefined);
    }

    if (pending.length > 0) {
      await EnginePublishActivity({ events: pending.splice(0, pending.length) });
    }
  }

  void workflowInfo();

  return {
    runId: result.runId,
    agentId: ticket.agentSlug,
    outcome: result.outcome,
    ...(result.reason ? { reason: result.reason } : {}),
    outputs: result.outputs,
  };
}
