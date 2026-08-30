
import { buildModelRequest } from './model-request.js';
import { fittedMaxTokens } from './sampling.js';
import type { ModelKind } from './model-registry.js';
import type { SamplingConfig } from '@koala/harness-types';

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
  overrides: Record<string, unknown>;
  sampling?: SamplingConfig | undefined;
  maxTokens?: number;
  toolChoice?: 'none';
}

export function buildChatCompletionRequest(input: ChatCompletionRequest) {
  const { provider, messages, tools, overrides, sampling, maxTokens = 16000, toolChoice } = input;
  const built = buildModelRequest({
    turn: 'tool-turn',
    ...(provider?.kind ? { kind: provider.kind } : {}),
    messages: messages as any,
    tools: tools as unknown as any[],
    stream: true,
    maxTokens: fittedMaxTokens(maxTokens, JSON.stringify(messages).length),
    ...(provider?.model ? { model: provider.model } : {}),
    overrides,
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