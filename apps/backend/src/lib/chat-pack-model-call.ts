/* ═══════════════ chat-pack/model-call — build the provider request ═══════════════ */

/**
 * Builds the OpenAI-compatible chat-completion BODY a persona pack's turn sends to the model.
 *
 * Extracted from the router so the request shape is a pure, testable function. The load-bearing
 * detail is sampling: `tool-turn` selects `toolTurnSampling`, which drops the frequency/presence
 * penalties that measurably killed tool calls (see lib/sampling.ts) — a pack turn must never
 * inherit the conversation penalties.
 */
import { buildModelRequest } from './model-request.js';
import { fittedMaxTokens } from './sampling.js';
import type { ModelKind } from './model-registry.js';

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
  maxTokens?: number;
  /** When the budget runs dry: force a bare, tool-less final answer. */
  toolChoice?: 'none';
}

/** Builds the request BODY (the fetch payload), not the whole ModelRequest result. */
export function buildChatCompletionRequest(input: ChatCompletionRequest) {
  const { provider, messages, tools, overrides, maxTokens = 16000, toolChoice } = input;
  const built = buildModelRequest({
    turn: 'tool-turn',
    ...(provider?.kind ? { kind: provider.kind } : {}),
    messages: messages as any,
    tools: tools as unknown as any[],
    stream: true,
    maxTokens: fittedMaxTokens(maxTokens, JSON.stringify(messages).length),
    ...(provider?.model ? { model: provider.model } : {}),
    overrides,
    ...(toolChoice === 'none' ? { extra: { tool_choice: 'none' } } : {}),
  });
  return built.body as Record<string, unknown>;
}

/** Wraps the build step in a fetch to the provider. */
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