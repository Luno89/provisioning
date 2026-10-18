import type { ModelKind, SamplingConfig } from '@koala/harness-types';
import { buildModelRequest } from './model-request.js';
import { pause, rateLimitedFetch } from './model-rate-limiter.js';
import { patientFetch } from './patient-fetch.js';
import { createStreamParser, type StreamEvent, type StreamToolCall } from '../runtime/stream.js';

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
  onConnectionLost?: ((why: string) => void) | undefined;
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
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ModelCallError';
  }
}

async function* readChunks(body: unknown): AsyncGenerator<string> {
  const decoder = new TextDecoder();

  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield decoder.decode(value, { stream: true });
      }
    } finally {
      reader.cancel().catch(() => {});
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

  const fetchImpl = spec.fetchImpl ?? patientFetch;
  const doFetch = rateLimitedFetch(endpoint.rateLimitKey, endpoint.ownerId, endpoint.label, fetchImpl);
  const headers = {
    'content-type': 'application/json',
    ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
  const body = JSON.stringify({ ...built.body, stream_options: { include_usage: true } });

  for (;;) {
    try {
      return await askOnce(sink, built.unsupported, () => doFetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        ...(spec.signal ? { signal: spec.signal } : {}),
      }));
    } catch (err) {
      if (spec.signal?.aborted || !connectionLost(err)) throw err;
      spec.onConnectionLost?.(describeLoss(err));
      await serverAnswers(endpoint, fetchImpl, headers, spec.signal);
    }
  }
}

const LOST_CONNECTION = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
]);

const causeCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

export function connectionLost(err: unknown): boolean {
  if (err instanceof ModelCallError || !(err instanceof Error) || err.name === 'AbortError') return false;
  const code = causeCode(err);
  if (code) return LOST_CONNECTION.has(code);
  return err.name === 'TypeError' && err.message === 'terminated';
}

const describeLoss = (err: unknown): string => {
  const code = causeCode(err);
  return code ? `${(err as Error).message} (${code})` : (err as Error).message;
};

const ANSWER_WAIT_FIRST_MS = 2_000;
const ANSWER_WAIT_MOST_MS = 30_000;

async function serverAnswers(endpoint: EngineEndpoint, fetchImpl: typeof fetch, headers: Record<string, string>, signal: AbortSignal | undefined): Promise<void> {
  for (let wait = ANSWER_WAIT_FIRST_MS; ; wait = Math.min(wait * 2, ANSWER_WAIT_MOST_MS)) {
    await pause(wait, signal);
    try {
      const answer = await fetchImpl(`${endpoint.baseUrl}/models`, { headers, ...(signal ? { signal } : {}) });
      await answer.body?.cancel().catch(() => {});
      if (answer.status < 500) return;
    } catch (err) {
      if (signal?.aborted) await pause(0, signal);
      if (!connectionLost(err)) throw err;
    }
  }
}

async function askOnce(
  sink: StreamSink,
  unsupported: string[],
  send: () => Promise<Response>,
): Promise<ModelCallResult> {
  const response = await send();

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
    unsupported,
    interrupted: undefined,
  };

  let emitted = false;

  const absorb = (events: StreamEvent[]): boolean => {
    for (const event of events) {
      if (event.kind === 'error') {
        if (!emitted) throw new ModelCallError(`Model stream error: ${event.error}`, 500);
        result.interrupted = `Model stream error: ${event.error}`;
        return true;
      }
      if (event.kind === 'content' || event.kind === 'thinking') emitted = true;
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
