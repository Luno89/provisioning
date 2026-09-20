import type { SamplingConfig } from '@koala/harness-types';
import type { EngineEvent, EventBus, RunOutcome } from '../runtime/events.js';
import { budgetExceeded, createRunState, type RunBudget, type RunCounters, type RunIdentity } from '../runtime/run.js';
import { GROUP_KIND, definitionFor, type NodeCatalogue, type NodeDefinition } from './definition.js';
import { expandGroups, groupLibrary } from './groups.js';
import type { GroupDefinition, NodeId, PlacedNode, Procedure } from './schema.js';
import { capForTrace } from './trace.js';
import { handledTools, type HandledTools } from './handled.js';

export interface UsageDelta {
  rounds?: number | undefined;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
  toolCalls?: number | undefined;
  childRuns?: number | undefined;
  cappedAt?: number | undefined;
}

export interface RunLaunch {
  ownerId: string;
  projectId?: string | undefined;
  conversationId?: string | undefined;
  modelId?: string | undefined;
  sampling?: SamplingConfig | undefined;
  environment?: unknown;
}

export interface RunContext {
  identity: RunIdentity;
  launch: RunLaunch;
  handles: HandledTools;
  inputs: Readonly<Record<string, unknown>>;
  counters: Readonly<RunCounters>;
  budget: Readonly<RunBudget>;
  signal?: AbortSignal | undefined;
  cleaningUp: boolean;
  emit(event: Omit<EngineEvent, 'runId' | 'at'>): void;
}

export interface NodeRequest {
  node: PlacedNode;
  origin: NodeId;
  definition: NodeDefinition;
  inputs: Record<string, unknown>;
  previous?: Readonly<Record<string, unknown>> | undefined;
  execution: number;
  run: RunContext;
}

export type StepResult =
  | { exit: string; outputs?: Record<string, unknown> | undefined; usage?: UsageDelta | undefined }
  | { finish: { outcome: RunOutcome; reason?: string | undefined }; outputs?: Record<string, unknown> | undefined; usage?: UsageDelta | undefined }
  | { interrupted: string; usage?: UsageDelta | undefined };

export interface ValueResult {
  outputs: Record<string, unknown>;
  usage?: UsageDelta | undefined;
}

export interface NodeExecutor {
  step(request: NodeRequest): Promise<StepResult>;
  value(request: NodeRequest): Promise<ValueResult>;
}

export interface NodeTrace {
  sequence: number;
  step: number;
  node: NodeId;
  origin: NodeId;
  kind: string;
  role: 'step' | 'value';
  cleanup: boolean;
  startedAt: number;
  durationMs: number;
  inputs: unknown;
  outputs?: unknown;
  exit?: string | undefined;
  finish?: { outcome: RunOutcome; reason?: string | undefined } | undefined;
  interrupted?: string | undefined;
  error?: string | undefined;
}

export interface RunProcedureOptions {
  procedure: Procedure;
  catalogue: NodeCatalogue;
  executor: NodeExecutor;
  identity: RunIdentity;
  launch: RunLaunch;
  groups?: readonly GroupDefinition[] | undefined;
  inputs?: Record<string, unknown> | undefined;
  budget?: RunBudget | undefined;
  bus?: EventBus | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  maxSteps?: number | undefined;
  onTrace?: ((trace: NodeTrace) => void) | undefined;
}

export interface ProcedureResult {
  runId: string;
  outcome: RunOutcome;
  reason?: string | undefined;
  counters: RunCounters;
  outputs: Record<NodeId, Record<string, unknown>>;
  finishedBy?: NodeId | undefined;
  steps: number;
}

export const PROCEDURE_STEP_CAP = 10_000;
export const CLEANUP_STEP_CAP = 100;

class RunStop extends Error {
  readonly outcome: RunOutcome;
  readonly reason: string;

  constructor(outcome: RunOutcome, reason: string) {
    super(reason);
    this.name = 'RunStop';
    this.outcome = outcome;
    this.reason = reason;
  }
}

class NotProducedYet extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'NotProducedYet';
    this.reason = reason;
  }
}

const routeKey = (node: NodeId, exit: string): string => JSON.stringify([node, exit]);

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runProcedure(options: RunProcedureOptions): Promise<ProcedureResult> {
  const now = options.now ?? (() => Date.now());
  const budget = options.budget ?? options.procedure.budget ?? {};
  const maxSteps = options.maxSteps ?? PROCEDURE_STEP_CAP;
  const { identity, executor, catalogue } = options;
  const handles = handledTools(options.procedure);

  const { body, origin } = expandGroups(options.procedure, groupLibrary(options.procedure, options.groups));
  const nodes = new Map(body.nodes.map((node) => [node.id, node]));
  const state = createRunState(now(), options.inputs ?? {});
  const counters = state.counters;

  const wiresInto = new Map<NodeId, typeof body.wires>();
  for (const wire of body.wires) wiresInto.set(wire.to.node, [...(wiresInto.get(wire.to.node) ?? []), wire]);

  const routes = new Map<string, NodeId>();
  for (const flow of body.flow) routes.set(routeKey(flow.from, flow.exit), flow.to);

  const latest = new Map<NodeId, Record<string, unknown>>();
  let sequence = 0;
  let stepNumber = 0;
  let executions = 0;

  const emit = (event: Omit<EngineEvent, 'runId' | 'at'>) =>
    options.bus?.emit({ ...event, runId: identity.runId, at: new Date(now()).toISOString() } as EngineEvent);

  const definitionOf = (node: PlacedNode): NodeDefinition => {
    if (node.kind === GROUP_KIND) {
      throw new RunStop('failed', `"${origin.get(node.id) ?? node.id}" is a group that was not expanded`);
    }
    const definition = definitionFor(catalogue, node);
    if (!definition) {
      throw new RunStop('failed', `"${origin.get(node.id) ?? node.id}" is a "${node.kind}" node, and nothing knows how to run one`);
    }
    return definition;
  };

  const addUsage = (usage: UsageDelta | undefined) => {
    if (!usage) return;
    counters.rounds += usage.rounds ?? 0;
    counters.promptTokens += usage.promptTokens ?? 0;
    counters.completionTokens += usage.completionTokens ?? 0;
    counters.longestReply = Math.max(counters.longestReply, usage.completionTokens ?? 0);
    counters.cappedAt = Math.max(counters.cappedAt, usage.cappedAt ?? 0);
    counters.totalTokens += usage.totalTokens ?? 0;
    counters.toolCalls += usage.toolCalls ?? 0;
    counters.childRuns += usage.childRuns ?? 0;
    counters.elapsedMs = now() - counters.startedAt;
  };

  const record = (trace: Omit<NodeTrace, 'sequence' | 'step' | 'origin'> & { node: NodeId }) => {
    sequence += 1;
    options.onTrace?.({
      sequence,
      step: stepNumber,
      origin: origin.get(trace.node) ?? trace.node,
      ...trace,
      inputs: capForTrace(trace.inputs),
      ...(trace.outputs !== undefined ? { outputs: capForTrace(trace.outputs) } : {}),
    });
  };

  const context = (cleaningUp: boolean, signal: AbortSignal | undefined): RunContext => ({
    identity,
    launch: options.launch,
    handles,
    inputs: state.inputs,
    counters,
    budget,
    cleaningUp,
    emit,
    ...(signal ? { signal } : {}),
  });

  const resolveInputs = async (
    node: PlacedNode,
    definition: NodeDefinition,
    memo: Map<NodeId, Record<string, unknown>>,
    evaluating: Set<NodeId>,
    run: RunContext,
  ): Promise<Record<string, unknown>> => {
    const resolved: Record<string, unknown> = {};

    for (const spec of definition.inputs) {
      const wires = (wiresInto.get(node.id) ?? []).filter((wire) => wire.to.socket === spec.name);
      const values: unknown[] = [];

      for (const wire of wires) {
        const source = nodes.get(wire.from.node);
        if (!source) throw new RunStop('failed', `"${node.id}" is wired from "${wire.from.node}", which does not exist`);

        let produced: Record<string, unknown> | undefined;
        if (definitionOf(source).role === 'value') {
          try {
            produced = await evaluateValue(source, memo, evaluating, run);
          } catch (err) {
            if (!(err instanceof NotProducedYet) || spec.required) throw err;
          }
        } else {
          produced = latest.get(source.id);
        }

        values.push(produced?.[wire.from.socket]);
      }

      const present = values.filter((value) => value !== undefined);
      if (spec.required && present.length === 0) {
        const from = wires.map((wire) => `"${origin.get(wire.from.node) ?? wire.from.node}.${wire.from.socket}"`);
        throw new NotProducedYet(
          from.length > 0
            ? `"${origin.get(node.id) ?? node.id}" needs "${spec.name}", and ${from.join(' and ')} has not produced it yet`
            : `"${origin.get(node.id) ?? node.id}" needs "${spec.name}", and nothing is wired into it`,
        );
      }

      if (spec.many) resolved[spec.name] = present;
      else if (present.length > 0) resolved[spec.name] = present[0];
    }

    return resolved;
  };

  const evaluateValue = async (
    node: PlacedNode,
    memo: Map<NodeId, Record<string, unknown>>,
    evaluating: Set<NodeId>,
    run: RunContext,
  ): Promise<Record<string, unknown>> => {
    const cached = memo.get(node.id);
    if (cached) return cached;
    if (evaluating.has(node.id)) {
      throw new RunStop('failed', `value nodes feed each other in a circle through "${origin.get(node.id) ?? node.id}"`);
    }

    evaluating.add(node.id);
    const definition = definitionOf(node);
    let inputs: Record<string, unknown>;
    try {
      inputs = await resolveInputs(node, definition, memo, evaluating, run);
    } catch (err) {
      evaluating.delete(node.id);
      throw err;
    }
    const startedAt = now();

    try {
      executions += 1;
      const result = await executor.value({ node, origin: origin.get(node.id) ?? node.id, definition, inputs, execution: executions, run });
      addUsage(result.usage);
      record({ node: node.id, kind: node.kind, role: 'value', cleanup: run.cleaningUp, startedAt, durationMs: now() - startedAt, inputs, outputs: result.outputs });
      memo.set(node.id, result.outputs);
      return result.outputs;
    } catch (err) {
      if (err instanceof RunStop) throw err;
      record({ node: node.id, kind: node.kind, role: 'value', cleanup: run.cleaningUp, startedAt, durationMs: now() - startedAt, inputs, error: describeError(err) });
      throw new RunStop('failed', `"${origin.get(node.id) ?? node.id}" failed: ${describeError(err)}`);
    } finally {
      evaluating.delete(node.id);
    }
  };

  const runStep = async (id: NodeId, run: RunContext): Promise<{ next?: NodeId; finish?: { outcome: RunOutcome; reason?: string | undefined } }> => {
    const node = nodes.get(id);
    if (!node) throw new RunStop('failed', `the procedure leads to "${id}", which does not exist`);
    const definition = definitionOf(node);
    if (definition.role !== 'step') {
      throw new RunStop('failed', `the procedure leads to "${origin.get(id) ?? id}", which is a value node and cannot run on its own`);
    }

    stepNumber += 1;
    emit({ type: 'node.entered', nodeId: id } as never);

    const memo = new Map<NodeId, Record<string, unknown>>();
    let inputs: Record<string, unknown>;
    try {
      inputs = await resolveInputs(node, definition, memo, new Set(), run);
    } catch (err) {
      if (err instanceof NotProducedYet) throw new RunStop('failed', err.reason);
      throw err;
    }
    const startedAt = now();

    let result: StepResult;
    try {
      executions += 1;
      const previous = latest.get(id);
      result = await executor.step({
        node,
        origin: origin.get(id) ?? id,
        definition,
        inputs,
        ...(previous ? { previous } : {}),
        execution: executions,
        run,
      });
    } catch (err) {
      record({ node: id, kind: node.kind, role: 'step', cleanup: run.cleaningUp, startedAt, durationMs: now() - startedAt, inputs, error: describeError(err) });
      emit({ type: 'node.exited', nodeId: id } as never);
      throw new RunStop('failed', `"${origin.get(id) ?? id}" failed: ${describeError(err)}`);
    }

    addUsage(result.usage);
    const base = { node: id, kind: node.kind, role: 'step' as const, cleanup: run.cleaningUp, startedAt, durationMs: now() - startedAt, inputs };

    if ('interrupted' in result) {
      record({ ...base, interrupted: result.interrupted });
      emit({ type: 'interrupted', reason: result.interrupted } as never);
      emit({ type: 'node.exited', nodeId: id } as never);
      throw new RunStop('interrupted', result.interrupted);
    }

    if (result.outputs) latest.set(id, result.outputs);

    if ('finish' in result) {
      record({ ...base, outputs: result.outputs, finish: result.finish });
      emit({ type: 'node.exited', nodeId: id } as never);
      return { finish: result.finish };
    }

    record({ ...base, outputs: result.outputs, exit: result.exit });
    emit({ type: 'node.exited', nodeId: id, via: result.exit } as never);

    if (!definition.exits.some((exit) => exit.name === result.exit)) {
      throw new RunStop('failed', `"${origin.get(id) ?? id}" left through "${result.exit}", which it does not declare`);
    }
    const next = routes.get(routeKey(id, result.exit));
    if (!next) {
      throw new RunStop('failed', `"${origin.get(id) ?? id}" left through "${result.exit}", and nothing says where that goes`);
    }
    return { next };
  };

  emit({ type: 'run.started', agentId: identity.agentId, loopId: identity.loopId, ...(identity.parentRunId ? { parentRunId: identity.parentRunId } : {}) } as never);

  let outcome: RunOutcome = 'failed';
  let reason: string | undefined;
  let finishedBy: NodeId | undefined;
  let steps = 0;

  try {
    let current: NodeId | undefined = body.start;
    const run = context(false, options.signal);

    while (current !== undefined) {
      if (options.signal?.aborted) {
        throw new RunStop('interrupted', typeof options.signal.reason === 'string' ? options.signal.reason : 'Stopped');
      }
      if (steps >= maxSteps) throw new RunStop('exhausted', `stopped after ${maxSteps} steps without finishing`);

      counters.elapsedMs = now() - counters.startedAt;
      const upcoming = nodes.get(current);
      const spends = upcoming && upcoming.kind !== GROUP_KIND ? catalogue.get(upcoming.kind)?.spends ?? [] : [];
      const overBudget = budgetExceeded(state, budget, identity, now(), spends);
      if (overBudget) throw new RunStop('exhausted', overBudget);

      steps += 1;
      const moved = await runStep(current, run);
      if (moved.finish) {
        outcome = moved.finish.outcome;
        reason = moved.finish.reason;
        finishedBy = current;
        break;
      }
      current = moved.next;
    }
  } catch (err) {
    if (!(err instanceof RunStop)) throw err;
    outcome = err.outcome;
    reason = err.reason;
  }

  if (body.cleanup !== undefined) {
    try {
      let current: NodeId | undefined = body.cleanup;
      const run = context(true, undefined);
      let cleanupSteps = 0;

      while (current !== undefined) {
        if (cleanupSteps >= CLEANUP_STEP_CAP) throw new RunStop('failed', `cleanup did not finish within ${CLEANUP_STEP_CAP} steps`);
        cleanupSteps += 1;
        const moved = await runStep(current, run);
        if (moved.finish) break;
        current = moved.next;
      }
    } catch (err) {
      if (!(err instanceof RunStop)) throw err;
      reason = reason ? `${reason}; cleanup failed: ${err.reason}` : `cleanup failed: ${err.reason}`;
      if (outcome === 'ok') outcome = 'failed';
    }
  }

  counters.elapsedMs = now() - counters.startedAt;
  emit({ type: 'run.finished', outcome, ...(reason ? { reason } : {}) } as never);

  return {
    runId: identity.runId,
    outcome,
    ...(reason ? { reason } : {}),
    counters,
    outputs: Object.fromEntries(latest),
    ...(finishedBy ? { finishedBy } : {}),
    steps,
  };
}
