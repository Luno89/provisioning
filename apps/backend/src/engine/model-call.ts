import type { ModelKind, SamplingConfig } from '@koala/harness-types';
import { buildModelRequest } from '../lib/model-request.js';
import { rateLimitedFetch } from '../lib/model-rate-limiter.js';
import { createStreamParser, type StreamEvent, type StreamToolCall } from './stream.js';

export interface EngineEndpoint {
  baseUrl: string;
  apiKey?: string | undefined;
  model?: string | undefined;
  kind?: ModelKind | undefined;
  rateLimitKey: string;
  ownerId: string;
  label: string;
}

export interface ModelCallSpec {
  endpoint: EngineEndpoint;
  messages: unknown;
  tools?: unknown;
  sampling?: SamplingConfig | undefined;
  maxTokens: number;
  reasoningEffort?: string | undefined;
  think?: boolean | undefined;
  toolChoice?: 'none' | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface ModelCallResult {
  content: string;
  thinking: string;
  toolCalls: StreamToolCall[];
  usage: Record<string, unknown> | undefined;
  finishReason: string;
  unsupported: string[];
  interrupted: string | undefined;
}

export type StreamSink = (event: StreamEvent) => void | string;

export class ModelCallError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ModelCallError';
  }
}

async function* readChunks(body: unknown): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
    return;
  }

  if (body && typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body as AsyncIterable<unknown>) {
      yield typeof chunk === 'string' ? chunk : decoder.decode(chunk as Uint8Array, { stream: true });
    }
  }
}

export async function callModel(spec: ModelCallSpec, sink: StreamSink = () => undefined): Promise<ModelCallResult> {
  const { endpoint } = spec;

  const built = buildModelRequest({
    turn: spec.tools ? 'tool-turn' : 'conversation',
    kind: endpoint.kind,
    messages: spec.messages,
    ...(spec.tools ? { tools: spec.tools } : {}),
    stream: true,
    maxTokens: spec.maxTokens,
    ...(spec.reasoningEffort ? { reasoningEffort: spec.reasoningEffort } : {}),
    ...(endpoint.model ? { model: endpoint.model } : {}),
    ...(spec.think === undefined ? {} : { think: spec.think }),
    ...(spec.sampling ? { sampling: spec.sampling } : {}),
    ...(spec.toolChoice ? { extra: { tool_choice: spec.toolChoice } } : {}),
  });

  const doFetch = rateLimitedFetch(
    endpoint.rateLimitKey,
    endpoint.ownerId,
    endpoint.label,
    spec.fetchImpl ?? fetch,
  );

  const response = await doFetch(`${endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
    },
    body: JSON.stringify({ ...built.body, stream_options: { include_usage: true } }),
    ...(spec.signal ? { signal: spec.signal } : {}),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ModelCallError(
      `Model call failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 400)}` : ''}`,
      response.status,
    );
  }

  const parser = createStreamParser();
  const result: ModelCallResult = {
    content: '',
    thinking: '',
    toolCalls: [],
    usage: undefined,
    finishReason: '',
    unsupported: built.unsupported,
    interrupted: undefined,
  };

  const absorb = (events: StreamEvent[]): boolean => {
    for (const event of events) {
      if (event.kind === 'content') result.content += event.text;
      if (event.kind === 'thinking') result.thinking += event.text;
      if (event.kind === 'toolCall') result.toolCalls.push(event.call);
      if (event.kind === 'usage') result.usage = event.usage;
      if (event.kind === 'finish') result.finishReason = event.reason;

      const interrupt = sink(event);
      if (typeof interrupt === 'string' && interrupt) {
        result.interrupted = interrupt;
        return true;
      }
    }
    return false;
  };

  for await (const chunk of readChunks(response.body)) {
    if (absorb(parser.push(chunk))) return result;
  }

  absorb(parser.flush());
  return result;
}
