import {
  callModel,
  contextPressure,
  createMonitorSet,
  fittedMaxTokens,
  createRunState,
  overthinkMonitor,
  type AgentDefinition,
  type EngineEndpoint,
} from '@koala/agent-engine';
import {
  COMPACT_INSTRUCTIONS,
  DECIDE_INSTRUCTIONS,
  DEFAULT_COMPACT_AT,
  DEFAULT_COMPACT_KEEP,
  DEFAULT_COMPACT_TAIL,
  compactedView,
  compactionBoundary,
  summaryRequest,
  type Compaction,
  DEFAULT_CONTEXT_MARGIN,
  DEFAULT_MIN_REPLY_TOKENS,
  promptCharacters,
  readDecision,
  replyExit,
  stepImplementation,
  toWireMessages,
  valueImplementation,
  type ChatMessage,
  type ModelBinding,
  type ModelReply,
  type NodeImplementation,
  type ToolSet,
} from '@koala/agent-engine/procedure';
import { toolSchemas } from '@koala/engine-core';
import type { ModelKind, SamplingConfig } from '@koala/harness-types';
import type { HostNodeServices } from './services.js';

const DEFAULT_CONTEXT_TOKENS = 32_000;

const roomForReply = (binding: ModelBinding, system: string, messages: readonly ChatMessage[]): number => fittedMaxTokens(
  {
    contextTokens: binding.contextTokens,
    contextMargin: DEFAULT_CONTEXT_MARGIN,
    minReplyTokens: DEFAULT_MIN_REPLY_TOKENS,
  } as never,
  binding.replyCeiling ?? Number.MAX_SAFE_INTEGER,
  promptCharacters(system, messages),
  binding.contextTokens,
);

const numberUsage = (usage: Record<string, unknown> | undefined, key: string): number => {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

export function withTemperature(base: SamplingConfig | undefined, temperature: number | undefined): SamplingConfig | undefined {
  if (temperature === undefined) return base;
  return {
    ...(base ?? { toolTurn: {}, conversation: {} }),
    toolTurn: { ...(base?.toolTurn ?? {}), temperature },
    conversation: { ...(base?.conversation ?? {}), temperature },
  };
}

export type ModelNodeServices = Pick<HostNodeServices, 'registry' | 'models' | 'streamMonitors' | 'fetchImpl' | 'efforts'>;

export function createModelNodes(services: ModelNodeServices): NodeImplementation[] {
  return [
    valueImplementation('persona', async ({ run }) => {
      const { ownerId } = run.launch;
      const slug = run.identity.agentId;
      const persona = await services.registry.agent(ownerId, slug);
      if (!persona) throw new Error(`there is no persona called "${slug}"`);

      return {
        outputs: {
          persona,
          prompt: persona.prompt.trim(),
          delegates: await services.registry.callable(ownerId, slug),
        },
      };
    }),

    valueImplementation('choose-model', async ({ node, inputs, run }) => {
      const persona = inputs.persona as AgentDefinition;
      const chosen = typeof node.settings.modelId === 'string' && node.settings.modelId.trim() ? node.settings.modelId.trim() : undefined;
      const modelId = chosen ?? run.launch.modelId;
      const endpointId = persona.model?.endpointId ?? undefined;
      const { provider } = await services.models.resolveBaseUrl(run.launch.ownerId, modelId, endpointId);
      const temperature = typeof node.settings.temperature === 'number' ? node.settings.temperature : undefined;
      const sampling = withTemperature(run.launch.sampling ?? persona.sampling, temperature);

      const written = typeof node.settings.replyCeiling === 'number' ? node.settings.replyCeiling : persona.model?.replyCeiling;
      const learned = written === undefined
        ? await services.efforts?.replyCeiling({
          ownerId: run.launch.ownerId,
          procedureId: run.identity.loopId,
          modelKey: provider.id,
          agentSlug: run.identity.agentId,
        })
        : undefined;

      const binding: ModelBinding = {
        providerId: provider.id,
        label: provider.name,
        ...(provider.model ? { model: provider.model } : {}),
        ...(provider.kind ? { kind: provider.kind } : {}),
        ...(modelId ? { modelId } : {}),
        ...(endpointId ? { endpointId } : {}),
        contextTokens: provider.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
        ...(written ?? learned ? { replyCeiling: written ?? learned } : {}),
        ...(sampling ? { sampling } : {}),
        ...(persona.model?.reasoningEffort ? { reasoningEffort: persona.model.reasoningEffort } : {}),
      };

      return { outputs: { binding } };
    }),

    stepImplementation('call-model', async (request) => {
      const { node, inputs, run, execution } = request;
      const binding = inputs.binding as ModelBinding;
      const messages = inputs.messages as ChatMessage[];
      const tools = (inputs.tools as ToolSet | undefined) ?? [];
      const { provider, baseUrl, apiKey } = await services.models.resolveBaseUrl(run.launch.ownerId, binding.modelId, binding.endpointId);

      const endpoint: EngineEndpoint = {
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(provider.model ? { model: provider.model } : {}),
        ...(provider.kind ? { kind: provider.kind as ModelKind } : {}),
        rateLimitKey: provider.id,
        ownerId: run.launch.ownerId,
        label: provider.name,
      };

      const stopOverthinking = node.settings.stopOverthinking !== false;
      const lastAsk = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
      const monitors = createMonitorSet(
        stopOverthinking ? (services.streamMonitors?.(request) ?? [overthinkMonitor({ seed: lastAsk })]) : [],
      );
      const state = createRunState();
      const reasoningEffort = typeof node.settings.reasoningEffort === 'string' ? node.settings.reasoningEffort : binding.reasoningEffort;

      const allowed = typeof inputs.maxTokens === 'number'
        ? inputs.maxTokens
        : roomForReply(binding, inputs.system as string, messages);

      const result = await callModel(
        {
          endpoint,
          messages: toWireMessages(inputs.system as string, messages),
          ...(tools.length > 0 ? { tools: toolSchemas(tools) } : {}),
          maxTokens: allowed,
          ...(binding.sampling ? { sampling: binding.sampling } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(node.settings.toolChoice === 'none' ? { toolChoice: 'none' as const } : {}),
          ...(run.signal ? { signal: run.signal } : {}),
          ...(services.fetchImpl ? { fetchImpl: services.fetchImpl } : {}),
        },
        (event) => {
          if (event.kind === 'thinking' || event.kind === 'content') {
            run.emit({ type: event.kind, nodeId: node.id, delta: event.text } as never);
          }
          return monitors.sink({ state })(event);
        },
      );

      const usage = {
        rounds: 1,
        ...(result.finishReason === 'length' ? { cappedAt: allowed } : {}),
        promptTokens: numberUsage(result.usage, 'prompt_tokens'),
        completionTokens: numberUsage(result.usage, 'completion_tokens'),
        totalTokens: numberUsage(result.usage, 'total_tokens'),
      };

      const reply: ModelReply = {
        id: `${node.id}#${execution}`,
        content: result.content,
        thinking: result.thinking,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls,
      };

      if (result.interrupted) {
        return {
          interrupted: result.interrupted,
          outputs: { reply, toolCalls: reply.toolCalls, content: reply.content },
          usage,
        };
      }

      return {
        exit: replyExit(reply),
        outputs: { reply, toolCalls: reply.toolCalls, content: reply.content },
        usage,
      };
    }),

    stepImplementation('decide', async ({ node, inputs, run }) => {
      const binding = inputs.binding as ModelBinding;
      const { provider, baseUrl, apiKey } = await services.models.resolveBaseUrl(run.launch.ownerId, binding.modelId, binding.endpointId);
      const question = typeof node.settings.question === 'string' ? node.settings.question : '';
      const asked: ChatMessage[] = [{
        role: 'user',
        content: `Question: ${question}\n\nText:\n${typeof inputs.text === 'string' ? inputs.text : JSON.stringify(inputs.text, null, 2)}`,
      }];

      const room = roomForReply(binding, DECIDE_INSTRUCTIONS, asked);

      const result = await callModel(
        {
          endpoint: {
            baseUrl,
            ...(apiKey ? { apiKey } : {}),
            ...(provider.model ? { model: provider.model } : {}),
            ...(provider.kind ? { kind: provider.kind as ModelKind } : {}),
            rateLimitKey: provider.id,
            ownerId: run.launch.ownerId,
            label: provider.name,
          },
          messages: toWireMessages(DECIDE_INSTRUCTIONS, asked),
          maxTokens: room,
          ...(binding.sampling ? { sampling: binding.sampling } : {}),
          ...(binding.reasoningEffort ? { reasoningEffort: binding.reasoningEffort } : {}),
          ...(run.signal ? { signal: run.signal } : {}),
          ...(services.fetchImpl ? { fetchImpl: services.fetchImpl } : {}),
        },
        () => undefined,
      );

      const usage = {
        rounds: 1,
        ...(result.finishReason === 'length' ? { cappedAt: room } : {}),
        promptTokens: numberUsage(result.usage, 'prompt_tokens'),
        completionTokens: numberUsage(result.usage, 'completion_tokens'),
        totalTokens: numberUsage(result.usage, 'total_tokens'),
      };
      if (result.interrupted) return { interrupted: result.interrupted, usage };

      const decision = readDecision(result.content);
      return { exit: decision, outputs: { decision, why: result.content.trim() }, usage };
    }),

    createCompactContextNode(services),
  ];
}

export function createCompactContextNode(services: Pick<HostNodeServices, 'models' | 'fetchImpl'>): NodeImplementation {
  return stepImplementation('compact-context', async ({ node, inputs, previous, run }) => {
    const messages = (inputs.messages as ChatMessage[] | undefined) ?? [];
    const binding = inputs.binding as ModelBinding;
    const system = typeof inputs.system === 'string' ? inputs.system : '';
    const at = typeof node.settings.at === 'number' ? node.settings.at : DEFAULT_COMPACT_AT;
    const keep = typeof node.settings.keep === 'number' ? node.settings.keep : DEFAULT_COMPACT_KEEP;
    const kept = previous?.compaction as Compaction | undefined;
    const view = compactedView(messages, kept);
    const unchanged = { messages: view, ...(kept && kept.through <= messages.length ? { compaction: kept } : {}) };

    const pressure = contextPressure({ contextTokens: binding.contextTokens, contextMargin: DEFAULT_CONTEXT_MARGIN } as never, promptCharacters(system, view), binding.contextTokens);
    if (pressure < at) return { exit: 'fits', outputs: unchanged };
    const boundary = compactionBoundary(view, keep, binding.contextTokens * 4 * DEFAULT_COMPACT_TAIL);
    if (boundary === 0) return { exit: 'fits', outputs: unchanged };

    const { provider, baseUrl, apiKey } = await services.models.resolveBaseUrl(run.launch.ownerId, binding.modelId, binding.endpointId);
    const asked = summaryRequest(view.slice(0, boundary));
    const room = roomForReply(binding, COMPACT_INSTRUCTIONS, asked);
    const result = await callModel(
      {
        endpoint: {
          baseUrl,
          ...(apiKey ? { apiKey } : {}),
          ...(provider.model ? { model: provider.model } : {}),
          ...(provider.kind ? { kind: provider.kind as ModelKind } : {}),
          rateLimitKey: provider.id,
          ownerId: run.launch.ownerId,
          label: provider.name,
        },
        messages: toWireMessages(COMPACT_INSTRUCTIONS, asked),
        maxTokens: room,
        ...(binding.sampling ? { sampling: binding.sampling } : {}),
        ...(run.signal ? { signal: run.signal } : {}),
        ...(services.fetchImpl ? { fetchImpl: services.fetchImpl } : {}),
      },
      () => undefined,
    );
    const usage = {
      promptTokens: numberUsage(result.usage, 'prompt_tokens'),
      completionTokens: numberUsage(result.usage, 'completion_tokens'),
      totalTokens: numberUsage(result.usage, 'total_tokens'),
    };
    if (result.interrupted) return { interrupted: result.interrupted, usage };
    const summary = result.content.trim();
    if (!summary) throw new Error('the model was asked to summarise the conversation to fit its context window and returned nothing');

    const compaction: Compaction = { summary, through: kept && kept.through <= messages.length ? kept.through + boundary - 1 : boundary };
    run.emit({ type: 'notice', level: 'info', nodeId: node.id, message: `the conversation was summarised to fit the context window: ${compaction.through} earlier messages now stand as one summary` } as never);
    return { exit: 'compacted', outputs: { messages: compactedView(messages, compaction), compaction }, usage };
  });
}
