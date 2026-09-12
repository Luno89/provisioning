import type { RunOutcome } from './events.js';
import type { ModelCallResult } from './model-call.js';
import type { StreamToolCall } from './stream.js';

export type TriggerKind = 'user' | 'workflow' | 'agent' | 'event';

export interface RunIdentity {
  runId: string;
  parentRunId?: string | undefined;
  depth: number;
  agentId: string;
  loopId: string;
  loopVersion: string;
  trigger: TriggerKind;
}

export interface RunBudget {
  maxRounds?: number | undefined;
  maxTokens?: number | undefined;
  maxWallClockMs?: number | undefined;
  maxToolCalls?: number | undefined;
  maxDepth?: number | undefined;
  maxChildRuns?: number | undefined;
}

export interface RunCounters {
  rounds: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCalls: number;
  childRuns: number;
  startedAt: number;
  elapsedMs: number;
}

export interface ReplySnapshot {
  content: string;
  thinking: string;
  finishReason: string;
  toolCalls: StreamToolCall[];
}

export interface ToolOutcome {
  callId: string;
  name: string;
  ok: boolean;
  digest: string;
}

export interface ChildOutcome {
  runId: string;
  agentId: string;
  outcome: RunOutcome;
  reason?: string | undefined;
  outputs: Record<string, unknown>;
}

export interface RunState {
  reply: ReplySnapshot;
  tools: ToolOutcome[];
  children: ChildOutcome[];
  counters: RunCounters;
  detectors: Record<string, number | boolean>;
  outputs: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  outcome: RunOutcome;
  reason?: string | undefined;
  outputs: Record<string, unknown>;
  counters: RunCounters;
}

export const emptyReply = (): ReplySnapshot => ({
  content: '',
  thinking: '',
  finishReason: '',
  toolCalls: [],
});

export function createRunState(now: number = Date.now()): RunState {
  return {
    reply: emptyReply(),
    tools: [],
    children: [],
    counters: {
      rounds: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      childRuns: 0,
      startedAt: now,
      elapsedMs: 0,
    },
    detectors: {},
    outputs: {},
  };
}

const numberOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function applyModelResult(state: RunState, result: ModelCallResult, now: number = Date.now()): RunState {
  state.reply = {
    content: result.content,
    thinking: result.thinking,
    finishReason: result.finishReason,
    toolCalls: result.toolCalls,
  };
  state.counters.rounds += 1;
  state.counters.promptTokens += numberOf(result.usage?.prompt_tokens);
  state.counters.completionTokens += numberOf(result.usage?.completion_tokens);
  state.counters.totalTokens += numberOf(result.usage?.total_tokens);
  state.counters.elapsedMs = now - state.counters.startedAt;
  return state;
}

export function recordToolOutcome(state: RunState, outcome: ToolOutcome, now: number = Date.now()): RunState {
  state.tools.push(outcome);
  state.counters.toolCalls += 1;
  state.counters.elapsedMs = now - state.counters.startedAt;
  return state;
}

export function recordChildOutcome(state: RunState, outcome: ChildOutcome, now: number = Date.now()): RunState {
  state.children.push(outcome);
  state.counters.childRuns += 1;
  state.counters.elapsedMs = now - state.counters.startedAt;
  return state;
}

export function budgetExceeded(
  state: RunState,
  budget: RunBudget,
  identity: Pick<RunIdentity, 'depth'>,
  now: number = Date.now(),
): string | undefined {
  const { counters } = state;

  if (budget.maxDepth !== undefined && identity.depth > budget.maxDepth) {
    return `delegation went ${identity.depth} deep, past the limit of ${budget.maxDepth}`;
  }
  if (budget.maxRounds !== undefined && counters.rounds >= budget.maxRounds) {
    return `used all ${budget.maxRounds} rounds`;
  }
  if (budget.maxTokens !== undefined && counters.totalTokens >= budget.maxTokens) {
    return `spent ${counters.totalTokens} tokens, past the limit of ${budget.maxTokens}`;
  }
  if (budget.maxToolCalls !== undefined && counters.toolCalls >= budget.maxToolCalls) {
    return `made ${counters.toolCalls} tool calls, the limit is ${budget.maxToolCalls}`;
  }
  if (budget.maxChildRuns !== undefined && counters.childRuns >= budget.maxChildRuns) {
    return `started ${counters.childRuns} sub-agents, the limit is ${budget.maxChildRuns}`;
  }
  if (budget.maxWallClockMs !== undefined && now - counters.startedAt >= budget.maxWallClockMs) {
    return `ran for ${Math.round((now - counters.startedAt) / 1000)}s, past the limit of ${Math.round(budget.maxWallClockMs / 1000)}s`;
  }

  return undefined;
}

export function settle(
  identity: RunIdentity,
  state: RunState,
  outcome: RunOutcome,
  reason?: string,
): RunResult {
  return {
    runId: identity.runId,
    outcome,
    ...(reason ? { reason } : {}),
    outputs: state.outputs,
    counters: state.counters,
  };
}
