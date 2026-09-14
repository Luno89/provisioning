import { compileExpr, type CompiledExpr } from './expr.js';
import { nodeMap, type Edge, type LoopGraph, type LoopNode, type NodeId } from './graph.js';
import type { EngineEvent, EventBus } from './events.js';
import type { MonitorSet } from './monitors.js';
import { budgetExceeded, settle, type RunBudget, type RunIdentity, type RunResult, type RunState } from './run.js';
import { createDefaultRegistry } from './nodes/builtins.js';
import type { ExecutorPorts, HandlerContext, NodeRegistry, NodeResult } from './nodes/types.js';

export type {
  ExecutorPorts,
  HandlerContext,
  NodeHandler,
  NodeRegistry,
  NodeResult,
  ToolExecution,
  AgentRequest,
  MergeRequest,
  DispatchRequest,
  WaitRequest,
  WaitAnswer,
} from './nodes/types.js';

export interface RunGraphOptions {
  graph: LoopGraph;
  identity: RunIdentity;
  state: RunState;
  budget: RunBudget;
  bus: EventBus;
  ports: ExecutorPorts;
  registry?: NodeRegistry | undefined;
  monitors?: MonitorSet | undefined;
  signal?: AbortSignal | undefined;
  maxSteps?: number | undefined;
}

export const HARD_STEP_CAP = 10_000;

export function conditionScope(state: RunState): Record<string, unknown> {
  return {
    inputs: state.inputs,
    reply: state.reply,
    counters: state.counters,
    detectors: state.detectors,
    outputs: state.outputs,
    children: state.children,
    tools: state.tools,
  };
}

export async function runGraph(options: RunGraphOptions): Promise<RunResult> {
  const { graph, identity, state, budget, bus, ports } = options;
  const registry = options.registry ?? createDefaultRegistry();
  const now = ports.now ?? (() => Date.now());
  const map = nodeMap(graph);
  const compiled = new Map<string, CompiledExpr>();
  const stepCap = options.maxSteps ?? HARD_STEP_CAP;

  const emit = (event: Omit<EngineEvent, 'runId' | 'at'>): void => {
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

  const contextFor = (node: LoopNode): HandlerContext => ({
    node,
    identity,
    state,
    ports,
    ...(options.monitors ? { monitors: options.monitors } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    now,
    emit,
    runNode: async (nodeId: NodeId): Promise<NodeResult> => {
      const target = map.get(nodeId);
      if (!target) return { settle: { outcome: 'failed', reason: `"${nodeId}" does not exist` } };
      const handler = registry.get(target.kind);
      if (!handler) return { settle: { outcome: 'failed', reason: `nothing knows how to run a "${target.kind}" node` } };
      return handler(contextFor(target));
    },
  });

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

    const handler = registry.get(node.kind);
    if (!handler) return finish('failed', `nothing knows how to run a "${node.kind}" node`);

    emit({ type: 'node.entered', nodeId: node.id } as never);

    const result = await handler(contextFor(node));

    if (result.interrupted) {
      emit({ type: 'interrupted', reason: result.interrupted } as never);
      emit({ type: 'node.exited', nodeId: node.id } as never);
      return finish('interrupted', result.interrupted);
    }

    if (result.settle) {
      emit({ type: 'node.exited', nodeId: node.id } as never);
      return finish(result.settle.outcome, result.settle.reason);
    }

    const edges = node.next ?? [];
    const taken = result.jumpTo ? undefined : edges.find(conditionPasses);
    const nextId = result.jumpTo ?? taken?.to;

    emit({ type: 'node.exited', nodeId: node.id, ...(taken?.when ? { via: taken.when } : {}) } as never);

    if (!nextId) return finish('failed', `no route out of "${node.id}" matched`);

    currentId = nextId;
  }

  return finish('failed', 'the loop ran out of nodes without reaching a terminal');
}
