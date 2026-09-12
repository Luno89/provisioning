import { compileExpr, type CompiledExpr } from './expr.js';
import { nodeMap, type Edge, type LoopGraph, type LoopNode, type NodeId } from './graph.js';
import type { AgentNode, FanOutNode, MergeNode, ModelNode, ToolNode, TransformNode } from './graph.js';
import type { EngineEvent, EventBus } from './events.js';
import type { ModelCallResult, StreamSink } from './model-call.js';
import type { MonitorSet } from './monitors.js';
import {
  applyModelResult,
  budgetExceeded,
  recordChildOutcome,
  recordToolOutcome,
  settle,
  type ChildOutcome,
  type RunBudget,
  type RunIdentity,
  type RunResult,
  type RunState,
} from './run.js';

export interface NodeContext<N extends LoopNode = LoopNode> {
  node: N;
  identity: RunIdentity;
  state: RunState;
  signal?: AbortSignal | undefined;
  sink?: StreamSink | undefined;
}

export interface ToolExecution {
  callId?: string | undefined;
  ok: boolean;
  digest: string;
}

export interface AgentRequest {
  agent: string;
  inputs: Record<string, unknown>;
  parent: RunIdentity;
  signal?: AbortSignal | undefined;
}

export interface MergeRequest {
  strategy?: string | undefined;
  children: ChildOutcome[];
  state: RunState;
}

export interface ExecutorPorts {
  callModel(ctx: NodeContext<ModelNode>): Promise<ModelCallResult>;
  runTool(ctx: NodeContext<ToolNode>): Promise<ToolExecution>;
  runAgent(request: AgentRequest): Promise<ChildOutcome>;
  runTransform(ctx: NodeContext<TransformNode>): Promise<Record<string, unknown>> | Record<string, unknown>;
  mergeChildren(request: MergeRequest): Promise<Record<string, unknown>> | Record<string, unknown>;
  now?(): number;
}

export interface RunGraphOptions {
  graph: LoopGraph;
  identity: RunIdentity;
  state: RunState;
  budget: RunBudget;
  bus: EventBus;
  ports: ExecutorPorts;
  monitors?: MonitorSet | undefined;
  signal?: AbortSignal | undefined;
  maxSteps?: number | undefined;
}

export const HARD_STEP_CAP = 10_000;

export function conditionScope(state: RunState): Record<string, unknown> {
  return {
    reply: state.reply,
    counters: state.counters,
    detectors: state.detectors,
    outputs: state.outputs,
    children: state.children,
    tools: state.tools,
  };
}

function readPath(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export async function runGraph(options: RunGraphOptions): Promise<RunResult> {
  const { graph, identity, state, budget, bus, ports } = options;
  const now = ports.now ?? (() => Date.now());
  const map = nodeMap(graph);
  const compiled = new Map<string, CompiledExpr>();
  const stepCap = options.maxSteps ?? HARD_STEP_CAP;

  const emit = (event: Omit<EngineEvent, 'runId' | 'at'> & { type: EngineEvent['type'] }): void => {
    bus.emit({ ...event, runId: identity.runId, at: new Date(now()).toISOString() } as EngineEvent);
  };

  const conditionPasses = (edge: Edge): boolean => {
    if (!edge.when) return true;
    let expr = compiled.get(edge.when);
    if (!expr) {
      expr = compileExpr(edge.when);
      compiled.set(edge.when, expr);
    }
    return expr.evaluate(conditionScope(state));
  };

  const finish = (outcome: RunResult['outcome'], reason?: string): RunResult => {
    emit({ type: 'run.finished', outcome, ...(reason ? { reason } : {}) } as never);
    return settle(identity, state, outcome, reason);
  };

  emit({
    type: 'run.started',
    agentId: identity.agentId,
    loopId: identity.loopId,
    ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}),
  } as never);

  let currentId: NodeId | undefined = graph.entry;
  let steps = 0;

  while (currentId) {
    if (steps++ >= stepCap) {
      return finish('exhausted', `stopped after ${stepCap} steps without settling`);
    }

    if (options.signal?.aborted) {
      emit({ type: 'interrupted', reason: 'Stopped' } as never);
      return finish('interrupted', 'Stopped');
    }

    const overBudget = budgetExceeded(state, budget, identity, now());
    if (overBudget) return finish('exhausted', overBudget);

    const node: LoopNode | undefined = map.get(currentId);
    if (!node) return finish('failed', `the loop points at "${currentId}", which does not exist`);

    emit({ type: 'node.entered', nodeId: node.id } as never);

    let jumpTo: NodeId | undefined;

    if (node.kind === 'terminal') {
      emit({ type: 'node.exited', nodeId: node.id } as never);
      return finish(node.outcome, node.reason);
    }

    if (node.kind === 'model') {
      emit({
        type: 'model.requested',
        nodeId: node.id,
        toolNames: node.tools === 'none' ? [] : ['granted'],
      } as never);

      const result = await ports.callModel({
        node,
        identity,
        state,
        signal: options.signal,
        ...(options.monitors ? { sink: options.monitors.sink({ state }) } : {}),
      });
      applyModelResult(state, result, now());
      options.monitors?.publish(state);

      if (result.interrupted) {
        emit({ type: 'interrupted', reason: result.interrupted } as never);
        emit({ type: 'node.exited', nodeId: node.id } as never);
        return finish('interrupted', result.interrupted);
      }

      const roundVerdict = options.monitors?.roundEnded({ state });
      if (roundVerdict) {
        options.monitors?.publish(state);
        emit({ type: 'interrupted', reason: roundVerdict } as never);
        emit({ type: 'node.exited', nodeId: node.id } as never);
        return finish('interrupted', roundVerdict);
      }
      options.monitors?.publish(state);
    }

    if (node.kind === 'tool') {
      const execution = await ports.runTool({ node, identity, state, signal: options.signal });
      const callId = execution.callId ?? `${node.id}-${state.counters.toolCalls}`;
      emit({ type: 'tool.called', nodeId: node.id, callId, name: node.tool, args: JSON.stringify(node.args ?? {}) } as never);
      const outcome = { callId, name: node.tool, ok: execution.ok, digest: execution.digest };
      recordToolOutcome(state, outcome, now());
      emit({ type: 'tool.result', nodeId: node.id, callId, ok: execution.ok, digest: execution.digest } as never);

      const toolVerdict = options.monitors?.toolResulted(outcome, { state });
      options.monitors?.publish(state);
      if (toolVerdict) {
        emit({ type: 'interrupted', reason: toolVerdict } as never);
        emit({ type: 'node.exited', nodeId: node.id } as never);
        return finish('interrupted', toolVerdict);
      }
    }

    if (node.kind === 'agent') {
      const child = await ports.runAgent({
        agent: node.agent,
        inputs: node.inputs ?? {},
        parent: identity,
        signal: options.signal,
      });
      recordChildOutcome(state, child, now());
      if (node.as) state.outputs[node.as] = child.outputs;
    }

    if (node.kind === 'transform') {
      const produced = await ports.runTransform({ node, identity, state, signal: options.signal });
      if (node.as) state.outputs[node.as] = produced;
      else Object.assign(state.outputs, produced);
    }

    if (node.kind === 'fanout') {
      const source = readPath(conditionScope(state), node.over);
      const items = Array.isArray(source) ? source : [];
      const limit = node.maxParallel && node.maxParallel > 0 ? node.maxParallel : items.length || 1;
      const produced: ChildOutcome[] = [];

      for (let offset = 0; offset < items.length; offset += limit) {
        if (options.signal?.aborted) {
          emit({ type: 'interrupted', reason: 'Stopped' } as never);
          return finish('interrupted', 'Stopped');
        }
        const slice = items.slice(offset, offset + limit);
        const settled = await Promise.all(slice.map((item, index) => ports.runAgent({
          agent: node.agent,
          inputs: { item, index: offset + index },
          parent: identity,
          signal: options.signal,
        })));
        produced.push(...settled);
      }

      for (const child of produced) recordChildOutcome(state, child, now());
      if (node.as) state.outputs[node.as] = produced.map((child) => child.outputs);
      jumpTo = node.join;
    }

    if (node.kind === 'merge') {
      const merged = await ports.mergeChildren({
        ...(node.strategy ? { strategy: node.strategy } : {}),
        children: state.children,
        state,
      });
      Object.assign(state.outputs, merged);
    }

    const edges = node.next ?? [];
    const taken = jumpTo ? undefined : edges.find(conditionPasses);
    const nextId = jumpTo ?? taken?.to;

    emit({ type: 'node.exited', nodeId: node.id, ...(taken?.when ? { via: taken.when } : {}) } as never);

    if (!nextId) {
      return finish('failed', `no route out of "${node.id}" matched`);
    }

    currentId = nextId;
  }

  return finish('failed', 'the loop ran out of nodes without reaching a terminal');
}
