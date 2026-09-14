import type {
  AgentNode,
  BranchNode,
  DispatchNode,
  FanOutNode,
  MergeNode,
  ModelNode,
  ParallelNode,
  TerminalNode,
  ToolNode,
  WaitNode,
} from '../graph.js';
import { BUILT_IN_REDUCERS, type BuiltInReducer } from '../graph.js';
import { applyModelResult, recordChildOutcome, recordToolOutcome, type ChildOutcome } from '../run.js';
import { CONTINUE, createRegistry, recordTool, type HandlerContext, type NodeHandler, type NodeRegistry, type NodeResult } from './types.js';

function parseToolContent(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readPath(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope;
  for (const segment of path.split('.')) {
    if (current === undefined || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function scopeOf(ctx: HandlerContext): Record<string, unknown> {
  return {
    inputs: ctx.state.inputs,
    reply: ctx.state.reply,
    counters: ctx.state.counters,
    detectors: ctx.state.detectors,
    outputs: ctx.state.outputs,
    children: ctx.state.children,
    tools: ctx.state.tools,
  };
}

export const modelNode: NodeHandler<ModelNode> = async (ctx): Promise<NodeResult> => {
  ctx.emit({
    type: 'model.requested',
    nodeId: ctx.node.id,
    toolNames: ctx.node.tools === 'none' ? [] : ['granted'],
  } as never);

  const result = await ctx.ports.callModel({
    node: ctx.node,
    identity: ctx.identity,
    state: ctx.state,
    signal: ctx.signal,
    ...(ctx.monitors ? { sink: ctx.monitors.sink({ state: ctx.state }) } : {}),
  });

  applyModelResult(ctx.state, result, ctx.now());
  ctx.monitors?.publish(ctx.state);

  if (result.interrupted) return { interrupted: result.interrupted };

  const verdict = ctx.monitors?.roundEnded({ state: ctx.state });
  ctx.monitors?.publish(ctx.state);
  if (verdict) return { interrupted: verdict };

  return CONTINUE;
};

export const dispatchNode: NodeHandler<DispatchNode> = async (ctx): Promise<NodeResult> => {
  const pending = ctx.state.reply.toolCalls;
  const results: Record<string, unknown>[] = [];

  for (const call of pending) {
    if (ctx.signal?.aborted) return { interrupted: 'Stopped' };

    ctx.emit({ type: 'tool.called', nodeId: ctx.node.id, callId: call.id, name: call.name, args: call.arguments } as never);
    const execution = await ctx.ports.dispatchTool({
      node: ctx.node,
      identity: ctx.identity,
      state: ctx.state,
      signal: ctx.signal,
      call,
    });

    const outcome = { callId: call.id, name: call.name, ok: execution.ok, digest: execution.digest };
    recordToolOutcome(ctx.state, outcome, ctx.now());
    ctx.emit({ type: 'tool.result', nodeId: ctx.node.id, callId: call.id, ok: execution.ok, digest: execution.digest } as never);
    results.push({ name: call.name, ok: execution.ok, digest: execution.digest });

    const verdict = recordTool(ctx, outcome);
    if (verdict) return { interrupted: verdict };
  }

  if (ctx.node.as) ctx.state.outputs[ctx.node.as] = results;
  ctx.state.reply.toolCalls = [];

  return CONTINUE;
};

const TEMPLATE = /^\{\{\s*([\w.]+)\s*\}\}$/;

export function resolveArgs(
  args: Record<string, unknown> | undefined,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  const resolve = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = TEMPLATE.exec(value);
      if (whole) return readPath(scope, whole[1]!);
      return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
        const found = readPath(scope, path);
        return found === undefined || found === null ? '' : String(found);
      });
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolve(v)]));
    }
    return value;
  };

  return resolve(args ?? {}) as Record<string, unknown>;
};

export const toolNode: NodeHandler<ToolNode> = async (ctx): Promise<NodeResult> => {
  const resolved = { ...ctx.node, args: resolveArgs(ctx.node.args, scopeOf(ctx)) };
  const execution = await ctx.ports.runTool({
    node: resolved,
    identity: ctx.identity,
    state: ctx.state,
    signal: ctx.signal,
  });

  const callId = execution.callId ?? `${ctx.node.id}-${ctx.state.counters.toolCalls}`;
  ctx.emit({
    type: 'tool.called',
    nodeId: ctx.node.id,
    callId,
    name: ctx.node.tool,
    args: JSON.stringify(ctx.node.args ?? {}),
  } as never);

  const outcome = { callId, name: ctx.node.tool, ok: execution.ok, digest: execution.digest };
  recordToolOutcome(ctx.state, outcome, ctx.now());

  if (ctx.node.as) {
    ctx.state.outputs[ctx.node.as] = parseToolContent(execution.content ?? execution.digest);
  }
  ctx.emit({ type: 'tool.result', nodeId: ctx.node.id, callId, ok: execution.ok, digest: execution.digest } as never);

  const verdict = recordTool(ctx, outcome);
  if (verdict) return { interrupted: verdict };

  return CONTINUE;
};

export const agentNode: NodeHandler<AgentNode> = async (ctx): Promise<NodeResult> => {
  const child = await ctx.ports.runAgent({
    agent: ctx.node.agent,
    inputs: ctx.node.inputs ?? {},
    parent: ctx.identity,
    signal: ctx.signal,
  });

  recordChildOutcome(ctx.state, child, ctx.now());
  if (ctx.node.as) ctx.state.outputs[ctx.node.as] = child.outputs;

  return CONTINUE;
};

export const fanOutNode: NodeHandler<FanOutNode> = async (ctx): Promise<NodeResult> => {
  const source = readPath(scopeOf(ctx), ctx.node.over);
  const items = Array.isArray(source) ? source : [];
  const limit = ctx.node.maxParallel && ctx.node.maxParallel > 0 ? ctx.node.maxParallel : items.length || 1;
  const produced: ChildOutcome[] = [];

  for (let offset = 0; offset < items.length; offset += limit) {
    if (ctx.signal?.aborted) return { interrupted: 'Stopped' };

    const slice = items.slice(offset, offset + limit);
    const settled = await Promise.all(slice.map((item, index) => ctx.ports.runAgent({
      agent: ctx.node.agent,
      inputs: { item, index: offset + index },
      parent: ctx.identity,
      signal: ctx.signal,
    })));
    produced.push(...settled);
  }

  for (const child of produced) recordChildOutcome(ctx.state, child, ctx.now());
  if (ctx.node.as) ctx.state.outputs[ctx.node.as] = produced.map((child) => child.outputs);

  return { jumpTo: ctx.node.join };
};

const REDUCERS: Record<BuiltInReducer, (children: readonly ChildOutcome[]) => ChildOutcome[]> = {
  all: (children) => [...children],
  ok: (children) => children.filter((child) => child.outcome === 'ok'),
  'first-ok': (children) => children.filter((child) => child.outcome === 'ok').slice(0, 1),
  failed: (children) => children.filter((child) => child.outcome !== 'ok'),
};

export const mergeNode: NodeHandler<MergeNode> = async (ctx): Promise<NodeResult> => {
  const strategy = ctx.node.strategy ?? 'all';
  const reduce = REDUCERS[strategy as BuiltInReducer];

  if (reduce) {
    const kept = reduce(ctx.state.children).map((child) => ({
      agent: child.agentId,
      outcome: child.outcome,
      ...(child.reason ? { reason: child.reason } : {}),
      outputs: child.outputs,
    }));

    ctx.state.outputs[ctx.node.as ?? 'merged'] = kept;
    return CONTINUE;
  }

  const merged = await ctx.ports.mergeChildren({
    strategy,
    children: ctx.state.children,
    state: ctx.state,
  });

  if (ctx.node.as) ctx.state.outputs[ctx.node.as] = merged;
  else Object.assign(ctx.state.outputs, merged);

  return CONTINUE;
};

export const waitNode: NodeHandler<WaitNode> = async (ctx): Promise<NodeResult> => {
  if (!ctx.ports.awaitAnswer) {
    return { settle: { outcome: 'failed', reason: 'this run cannot pause to ask a person anything' } };
  }

  ctx.emit({ type: 'notice', level: 'info', message: ctx.node.prompt } as never);

  const answer = await ctx.ports.awaitAnswer({
    node: ctx.node,
    identity: ctx.identity,
    state: ctx.state,
    prompt: ctx.node.prompt,
    signal: ctx.signal,
  });

  if (!answer.answered) {
    return { settle: { outcome: 'exhausted', reason: answer.reason ?? 'nobody answered' } };
  }

  if (ctx.node.as) ctx.state.outputs[ctx.node.as] = answer.value;

  return CONTINUE;
};

export const parallelNode: NodeHandler<ParallelNode> = async (ctx): Promise<NodeResult> => {
  const settled = await Promise.all(ctx.node.branches.map((branch) => ctx.runNode(branch)));

  const interrupted = settled.find((result) => result.interrupted);
  if (interrupted) return { interrupted: interrupted.interrupted };

  const failed = settled.find((result) => result.settle && result.settle.outcome !== 'ok');
  if (failed?.settle) return { settle: failed.settle };

  return { jumpTo: ctx.node.join };
};

export const branchNode: NodeHandler<BranchNode> = async (): Promise<NodeResult> => CONTINUE;

export const terminalNode: NodeHandler<TerminalNode> = async (ctx): Promise<NodeResult> => ({
  settle: { outcome: ctx.node.outcome, ...(ctx.node.reason ? { reason: ctx.node.reason } : {}) },
});

export function createDefaultRegistry(): NodeRegistry {
  const registry = createRegistry();

  registry.register('model', modelNode as NodeHandler<never>);
  registry.register('dispatch', dispatchNode as NodeHandler<never>);
  registry.register('tool', toolNode as NodeHandler<never>);
  registry.register('agent', agentNode as NodeHandler<never>);
  registry.register('fanout', fanOutNode as NodeHandler<never>);
  registry.register('merge', mergeNode as NodeHandler<never>);
  registry.register('wait', waitNode as NodeHandler<never>);
  registry.register('parallel', parallelNode as NodeHandler<never>);
  registry.register('branch', branchNode as NodeHandler<never>);
  registry.register('terminal', terminalNode as NodeHandler<never>);

  return registry;
}
