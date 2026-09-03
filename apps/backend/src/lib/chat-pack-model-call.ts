
import { buildModelRequest } from './model-request.js';
import { fittedMaxTokens } from './sampling.js';
import type { ModelKind } from './model-registry.js';
import type { BudgetConfig, SamplingConfig } from '@koala/harness-types';

export interface ModelProviderInfo {
  kind?: ModelKind;
  model?: string;
}

export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey?: string;
  provider?: ModelProviderInfo;
  messages: unknown[];
  tools: string[];
  sampling?: SamplingConfig | undefined;
  budget: BudgetConfig;
  maxTokens?: number;
  toolChoice?: 'none';
}

export function buildChatCompletionRequest(input: ChatCompletionRequest) {
  const { provider, messages, tools, sampling, budget, toolChoice } = input;
  const maxTokens = input.maxTokens ?? budget.replyTokens.ceiling;
  const built = buildModelRequest({
    // Which of the pack's own sampler profiles applies — per round, not hardcoded. A round
    // offering tool schemas samples as a tool-turn; a round with none samples as a conversation.
    turn: Array.isArray(tools) && tools.length > 0 ? 'tool-turn' : 'conversation',
    ...(provider?.kind ? { kind: provider.kind } : {}),
    messages: messages as any,
    tools: tools as unknown as any[],
    stream: true,
    maxTokens: fittedMaxTokens(budget, maxTokens, JSON.stringify(messages).length),
    ...(provider?.model ? { model: provider.model } : {}),
    ...(sampling ? { sampling } : {}),
    ...(toolChoice === 'none' ? { extra: { tool_choice: 'none' } } : {}),
  });
  return built.body as Record<string, unknown>;
}

export function makeChatCall(baseUrl: string, apiKey: string | undefined) {
  return (
    build: (m: unknown[], tools: string[], toolChoice?: 'none') => Record<string, unknown>,
  ) =>
  (messages: unknown[], tools: string[], toolChoice?: 'none') =>
    fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(build(messages, tools, toolChoice)),
    });
}