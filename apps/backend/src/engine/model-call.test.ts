import { describe, it, expect, vi } from 'vitest';
import { callModel, ModelCallError, type EngineEndpoint } from './model-call.js';
import type { StreamEvent } from './stream.js';

const endpoint = (over: Partial<EngineEndpoint> = {}): EngineEndpoint => ({
  baseUrl: 'https://models.test/v1',
  apiKey: 'secret-key',
  model: 'test-model',
  rateLimitKey: `bucket-${Math.random().toString(36).slice(2)}`,
  ownerId: 'user-1',
  label: 'Test Endpoint',
  ...over,
});

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n`;

function streamingResponse(chunks: string[], init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(),
    text: async () => chunks.join(''),
    body: (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  } as unknown as Response;
}

describe('callModel', () => {
  it('posts a streaming chat completion with auth and aggregates the reply', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] }),
      frame({ choices: [{ delta: { content: 'hello ' } }] }),
      frame({ choices: [{ delta: { content: 'world' } }], usage: { total_tokens: 12 } }),
      frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]));

    const result = await callModel({
      endpoint: endpoint(),
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.content).toBe('hello world');
    expect(result.thinking).toBe('thinking hard');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ total_tokens: 12 });
    expect(result.interrupted).toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://models.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-key');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('test-model');
  });

  it('omits the authorization header when the endpoint has no key', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([]));

    await callModel({
      endpoint: endpoint({ apiKey: undefined }),
      messages: [],
      maxTokens: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('returns tool calls reassembled from the stream', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'list_pods', arguments: '{"ns"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"default"}' } }] } }] }),
    ]));

    const result = await callModel({
      endpoint: endpoint(),
      messages: [],
      tools: [{ type: 'function', function: { name: 'list_pods' } }],
      maxTokens: 50,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'list_pods', arguments: '{"ns":"default"}' },
    ]);
  });

  it('throws ModelCallError carrying the status when the endpoint rejects the call', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse(['upstream is unhappy'], { ok: false, status: 502 }));

    await expect(callModel({
      endpoint: endpoint(),
      messages: [],
      maxTokens: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ name: 'ModelCallError', status: 502 });
  });

  it('stops mid-stream when the sink asks to interrupt, and keeps what it had', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([
      frame({ choices: [{ delta: { content: 'first ' } }] }),
      frame({ choices: [{ delta: { content: 'second' } }] }),
      frame({ choices: [{ delta: { content: 'third' } }] }),
    ]));

    const seen: StreamEvent[] = [];
    const result = await callModel(
      {
        endpoint: endpoint(),
        messages: [],
        maxTokens: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
      (event) => {
        seen.push(event);
        return seen.length === 2 ? 'looping' : undefined;
      },
    );

    expect(result.interrupted).toBe('looping');
    expect(result.content).toBe('first second');
    expect(seen).toHaveLength(2);
  });

  it('serializes concurrent calls on the same endpoint through the rate limiter', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return streamingResponse([frame({ choices: [{ delta: { content: 'ok' } }] })]);
    });

    const shared = endpoint();
    await Promise.all([
      callModel({ endpoint: shared, messages: [], maxTokens: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
      callModel({ endpoint: shared, messages: [], maxTokens: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
      callModel({ endpoint: shared, messages: [], maxTokens: 10, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
  });
});
