import { describe, it, expect, vi } from 'vitest';
import { callModel, connectionLost, ModelCallError, type EngineEndpoint } from './model-call.js';
import type { StreamEvent } from '../runtime/stream.js';

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

  const lost = (code: string, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: { code } });

  it('waits for the model\'s server to answer again after it refused the call, then asks again', async () => {
    vi.useFakeTimers();
    try {
      const asked: string[] = [];
      let modelsAsked = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        asked.push(url.endsWith('/models') ? 'models' : 'chat');
        if (url.endsWith('/models')) {
          modelsAsked += 1;
          if (modelsAsked < 3) throw lost('ECONNREFUSED');
          return modelsAsked === 3 ? new Response('loading', { status: 503 }) : new Response('{}', { status: 200 });
        }
        if (asked.filter((what) => what === 'chat').length === 1) throw lost('ECONNREFUSED');
        return streamingResponse([frame({ choices: [{ delta: { content: 'back' }, finish_reason: 'stop' }] })]);
      });
      const losses: string[] = [];
      const answer = callModel({
        endpoint: endpoint(),
        messages: [],
        maxTokens: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        onConnectionLost: (why) => losses.push(why),
      });
      await vi.runAllTimersAsync();
      const result = await answer;
      expect(result.content).toBe('back');
      expect(asked).toEqual(['chat', 'models', 'models', 'models', 'models', 'chat']);
      expect(losses).toEqual(['fetch failed (ECONNREFUSED)']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the answer over when the stream is cut off part way, keeping only the new answer', async () => {
    vi.useFakeTimers();
    try {
      let chats = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.endsWith('/models')) return new Response('{}', { status: 200 });
        chats += 1;
        if (chats === 1) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: (async function* () {
              yield frame({ choices: [{ delta: { content: 'half an ' } }] });
              throw lost('UND_ERR_SOCKET', 'terminated');
            })(),
          } as unknown as Response;
        }
        return streamingResponse([frame({ choices: [{ delta: { content: 'whole answer' }, finish_reason: 'stop' }] })]);
      });
      const seen: string[] = [];
      const losses: string[] = [];
      const answer = callModel(
        { endpoint: endpoint(), messages: [], maxTokens: 10, fetchImpl: fetchImpl as unknown as typeof fetch, onConnectionLost: (why) => losses.push(why) },
        (event) => { if (event.kind === 'content') seen.push(event.text); },
      );
      await vi.runAllTimersAsync();
      const result = await answer;
      expect(result.content).toBe('whole answer');
      expect(result.finishReason).toBe('stop');
      expect(seen).toEqual(['half an ', 'whole answer']);
      expect(losses).toEqual(['terminated (UND_ERR_SOCKET)']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait on an address that does not exist, or once the run is stopped', async () => {
    const nowhere = vi.fn(async () => { throw lost('ENOTFOUND'); });
    await expect(callModel({ endpoint: endpoint(), messages: [], maxTokens: 10, fetchImpl: nowhere as unknown as typeof fetch })).rejects.toThrow('fetch failed');
    expect(nowhere).toHaveBeenCalledTimes(1);

    const stop = new AbortController();
    const refused = vi.fn(async (url: string) => {
      if (url.endsWith('/models')) stop.abort('the run was stopped');
      throw lost('ECONNREFUSED');
    });
    await expect(callModel({ endpoint: endpoint(), messages: [], maxTokens: 10, signal: stop.signal, fetchImpl: refused as unknown as typeof fetch })).rejects.toThrow('the run was stopped');

    expect(connectionLost(new ModelCallError('Model call failed (HTTP 502)', 502))).toBe(false);
    expect(connectionLost(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(connectionLost(lost('ECONNRESET'))).toBe(true);
  });
});
