import type { EngineEvent, RunOutcome } from '../events.js';
import type { LoopNode, NodeId } from '../graph.js';
import type { MonitorSet } from '../monitors.js';
import type { ModelCallResult, StreamSink } from '../model-call.js';
import type { ChildOutcome, RunIdentity, RunState, ToolOutcome } from '../run.js';
import type { StreamToolCall } from '../stream.js';

export interface ToolExecution {
  callId?: string | undefined;
  ok: boolean;
  digest: string;
  content?: string | undefined;
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

export interface ModelRequest {
  node: LoopNode;
  identity: RunIdentity;
  state: RunState;
  signal?: AbortSignal | undefined;
  sink?: StreamSink | undefined;
}

export interface ToolRequest {
  node: LoopNode;
  identity: RunIdentity;
  state: RunState;
  signal?: AbortSignal | undefined;
}

export interface DispatchRequest extends ToolRequest {
  call: StreamToolCall;
}

export interface WaitRequest {
  node: LoopNode;
  identity: RunIdentity;
  state: RunState;
  prompt: string;
  signal?: AbortSignal | undefined;
}

export interface WaitAnswer {
  answered: boolean;
  value?: unknown;
  reason?: string | undefined;
}

export interface ExecutorPorts {
  callModel(request: ModelRequest): Promise<ModelCallResult>;
  runTool(request: ToolRequest): Promise<ToolExecution>;
  dispatchTool(request: DispatchRequest): Promise<ToolExecution>;
  runAgent(request: AgentRequest): Promise<ChildOutcome>;
  mergeChildren(request: MergeRequest): Promise<Record<string, unknown>> | Record<string, unknown>;
  awaitAnswer?(request: WaitRequest): Promise<WaitAnswer>;
  now?(): number;
}

export interface HandlerContext<N extends LoopNode = LoopNode> {
  node: N;
  identity: RunIdentity;
  state: RunState;
  ports: ExecutorPorts;
  monitors?: MonitorSet | undefined;
  signal?: AbortSignal | undefined;
  now(): number;
  emit(event: Omit<EngineEvent, 'runId' | 'at'>): void;
  runNode(nodeId: NodeId): Promise<NodeResult>;
}

export interface NodeResult {
  jumpTo?: NodeId | undefined;
  interrupted?: string | undefined;
  settle?: { outcome: RunOutcome; reason?: string | undefined } | undefined;
}

export const CONTINUE: NodeResult = {};

export type NodeHandler<N extends LoopNode = LoopNode> = (ctx: HandlerContext<N>) => Promise<NodeResult>;

export interface NodeRegistry {
  register(kind: string, handler: NodeHandler<never>): void;
  get(kind: string): NodeHandler | undefined;
  kinds(): string[];
}

export function createRegistry(): NodeRegistry {
  const handlers = new Map<string, NodeHandler>();

  return {
    register(kind: string, handler: NodeHandler<never>): void {
      handlers.set(kind, handler as NodeHandler);
    },
    get(kind: string): NodeHandler | undefined {
      return handlers.get(kind);
    },
    kinds(): string[] {
      return [...handlers.keys()].sort();
    },
  };
}

export function recordTool(
  ctx: HandlerContext,
  outcome: ToolOutcome,
): string | undefined {
  const verdict = ctx.monitors?.toolResulted(outcome, { state: ctx.state });
  ctx.monitors?.publish(ctx.state);
  return verdict;
}
