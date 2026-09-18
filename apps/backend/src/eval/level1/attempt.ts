import { createHash } from 'node:crypto';
import {
  BUILT_IN_GROUPS,
  builtInCatalogue,
  runProcedure,
  type ModelBinding,
  type ModelReply,
  type NodeExecutor,
  type ToolSet,
} from '@koala/agent-engine/procedure';
import { procedureBuilder } from '@koala/agent-engine/procedure-builder';
import type { ToolDefinition } from '@koala/agent-engine';
import type { SamplingConfig } from '@koala/harness-types';
import type { EvalCase } from '../cases.js';
import { scoreAttempt } from '../score.js';

export interface AttemptRecord {
  attempt: number;
  passed: boolean;
  complaint?: string | undefined;
  error?: string | undefined;
  systemHash?: string | undefined;
  toolsOffered: string[];
  content: string;
  thinking: string;
  toolCalls: { name: string; arguments: string }[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface AttemptOutcome {
  record: AttemptRecord;
  system?: string | undefined;
  model?: { key: string; label: string } | undefined;
  cappedAt?: number | undefined;
}

export interface AttemptOptions {
  executor: NodeExecutor;
  tools: (ownerId: string) => Promise<readonly ToolDefinition[]>;
  ownerId: string;
  runId: string;
  attempt: number;
  modelId?: string | undefined;
  sampling?: SamplingConfig | undefined;
  maxTokens?: number | undefined;
  signal?: AbortSignal | undefined;
}

const catalogue = builtInCatalogue();

export const LEVEL1_PROCEDURE = procedureBuilder({ catalogue, groups: BUILT_IN_GROUPS })({
  id: 'level-1-attempt',
  version: '1',
  name: 'Level 1 attempt',
  describe: 'One Model Turn, built exactly as a real run builds it, so the model sees what it would see for real.',
  budget: {},
}, (p) => {
  const input = p.runInput('input');
  const provision = p.provisionSandbox('provision');
  const conversation = p.conversation('conversation', { opening: input.message, given: input.inputs });
  const turn = p.groups.modelTurn('turn', { messages: conversation.messages, environment: provision.environment });
  const answered = p.finish('answered', { result: turn.content }, { outcome: 'ok' });
  const unavailable = p.finish('unavailable', { reason: provision.reason }, { outcome: 'failed' });
  const release = p.releaseSandbox('release', { environment: provision.environment });
  const released = p.finish('released', {}, { outcome: 'ok' });

  p.start(provision);
  p.cleanup(release);
  provision.on('ready', conversation);
  provision.on('unavailable', unavailable);
  conversation.on('done', turn);
  for (const exit of ['toolCalls', 'answered', 'truncated', 'empty'] as const) turn.on(exit, answered);
  release.on('done', released);

  p.layout({
    input: [0, 140],
    provision: [0, 0],
    conversation: [260, 0],
    turn: [520, 0],
    answered: [780, 0],
    unavailable: [260, 140],
    release: [0, 280],
    released: [260, 280],
  });
}).procedure;

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export async function runAttempt(entry: EvalCase, options: AttemptOptions): Promise<AttemptOutcome> {
  let system: string | undefined;
  let offered: string[] = [];
  let reply: ModelReply | undefined;
  let latencyMs = 0;
  let model: { key: string; label: string } | undefined;
  let cappedAt = 0;

  const executor: NodeExecutor = {
    async step(request) {
      if (request.node.kind !== 'call-model') return options.executor.step(request);
      system = typeof request.inputs.system === 'string' ? request.inputs.system : undefined;
      offered = ((request.inputs.tools as ToolSet | undefined) ?? []).map((tool) => tool.name);
      const started = Date.now();
      const result = await options.executor.step(request);
      latencyMs = Date.now() - started;
      if ('exit' in result && result.outputs?.reply) reply = result.outputs.reply as ModelReply;
      cappedAt = Math.max(cappedAt, (result as { usage?: { cappedAt?: number } }).usage?.cappedAt ?? 0);
      return result;
    },
    async value(request) {
      const result = await options.executor.value(request);
      if (request.node.kind === 'choose-model' && result.outputs?.binding) {
        const binding = result.outputs.binding as ModelBinding;
        model = { key: binding.providerId, label: binding.label };
      }
      if (request.node.kind === 'choose-model' && options.maxTokens && result.outputs?.binding) {
        return { ...result, outputs: { ...result.outputs, binding: { ...(result.outputs.binding as ModelBinding), replyCeiling: options.maxTokens } } };
      }
      return result;
    },
  };

  const result = await runProcedure({
    procedure: LEVEL1_PROCEDURE,
    catalogue,
    groups: BUILT_IN_GROUPS,
    executor,
    identity: {
      runId: `${options.runId}-${entry.name.replace(/[^a-z0-9]+/gi, '-')}-${options.attempt}`,
      depth: 0,
      agentId: entry.agent,
      loopId: LEVEL1_PROCEDURE.id,
      loopVersion: LEVEL1_PROCEDURE.version,
      trigger: 'user',
    },
    launch: {
      ownerId: options.ownerId,
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.sampling ? { sampling: options.sampling } : {}),
    },
    inputs: { message: entry.say },
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const base = {
    attempt: options.attempt,
    ...(system !== undefined ? { systemHash: hashOf(system) } : {}),
    toolsOffered: offered,
    content: reply?.content ?? '',
    thinking: reply?.thinking ?? '',
    toolCalls: (reply?.toolCalls ?? []).map((call) => ({ name: call.name, arguments: call.arguments })),
    promptTokens: result.counters.promptTokens,
    completionTokens: result.counters.completionTokens,
    totalTokens: result.counters.totalTokens,
    latencyMs,
  };

  if (!reply) {
    const error = result.reason ? `the model was never asked: ${result.reason}` : 'the model was never asked';
    return { record: { ...base, passed: false, complaint: error, error }, system, model, cappedAt };
  }

  const contract = (await options.tools(options.ownerId)).find((tool) => tool.name === entry.expect.tool);
  const verdict = scoreAttempt({ toolCalls: base.toolCalls, content: base.content }, entry.expect, contract);
  return {
    record: { ...base, passed: verdict.passed, ...(verdict.complaint ? { complaint: verdict.complaint } : {}) },
    system,
    model,
    cappedAt,
  };
}
