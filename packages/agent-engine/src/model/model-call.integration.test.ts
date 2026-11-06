import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { callModel, ModelCallError, type EngineEndpoint } from './model-call.js';
import { getModelRateLimiterSnapshot } from './model-rate-limiter.js';
import { overthinkMonitor } from '../runtime/monitors.js';
import { createRunState } from '../runtime/run.js';
import { cutAfter, delta, freePort, held, leftOpen, modelServer, refused, streamed, type ModelServer } from '../../testing/model-server.js';

const servers: ModelServer[] = [];

const serving = async (options: Parameters<typeof modelServer>[0] = {}): Promise<ModelServer> => {
  const server = await modelServer(options);
  servers.push(server);
  return server;
};

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

const endpointOf = (server: ModelServer, over: Partial<EngineEndpoint> = {}): EngineEndpoint => ({
  baseUrl: server.baseUrl,
  apiKey: 'the-key',
  model: 'stand-in',
  rateLimitKey: `bucket-${randomUUID()}`,
  ownerId: `owner-${randomUUID()}`,
  label: 'Stand-in',
  ...over,
});

const ask = [{ role: 'user', content: 'what is in the logs?' }];

const answering = (...words: string[]) => streamed(
  delta({ role: 'assistant', content: '' }),
  ...words.map((word) => delta({ content: word })),
  delta({}, 'stop'),
);

describe('a model call over a real connection', () => {
  it('streams thinking, words, a tool call split across chunks and the usage into one reply', async () => {
    const server = await serving();
    server.answerNext(streamed(
      delta({ role: 'assistant', reasoning_content: 'the logs ' }),
      delta({ reasoning_content: 'are long' }),
      delta({ content: 'Reading ' }),
      delta({ content: 'them.' }),
      delta({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"app.log"}' } }] }),
      delta({}, 'tool_calls'),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } })}\n\n`,
    ));

    const reply = await callModel({ endpoint: endpointOf(server), messages: ask, tools: [{ type: 'function', function: { name: 'read_file' } }], maxTokens: 300 });

    expect(reply.thinking).toBe('the logs are long');
    expect(reply.content).toBe('Reading them.');
    expect(reply.toolCalls).toEqual([{ id: 'call-1', name: 'read_file', arguments: '{"path":"app.log"}' }]);
    expect(reply.finishReason).toBe('tool_calls');
    expect(reply.usage).toEqual({ prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 });
    expect(reply.interrupted).toBeUndefined();
  });

  it('sends the model, the messages, the tools, the stream flags and the key as the server receives them', async () => {
    const server = await serving();
    server.answerNext(answering('fine'));

    await callModel({ endpoint: endpointOf(server), messages: ask, tools: [{ type: 'function', function: { name: 'read_file' } }], maxTokens: 300 });

    const [asked] = server.asked;
    expect(asked?.authorization).toBe('Bearer the-key');
    expect(asked?.body).toMatchObject({
      model: 'stand-in',
      messages: ask,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 300,
    });
  });

  it('fails with the status and what the server said when it refuses the call', async () => {
    const server = await serving();
    server.answerNext(refused(400, '{"error":"max_tokens is larger than the context"}'));

    const failure = await callModel({ endpoint: endpointOf(server), messages: ask, maxTokens: 300 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ModelCallError);
    expect((failure as ModelCallError).status).toBe(400);
    expect((failure as ModelCallError).message).toBe('Model call failed (HTTP 400): {"error":"max_tokens is larger than the context"}');
  });

  it('fails on an error the stream sends before the model said anything', async () => {
    const server = await serving();
    server.answerNext(streamed(`data: ${JSON.stringify({ error: { message: 'the model ran out of memory' } })}\n\n`));

    const failure = await callModel({ endpoint: endpointOf(server), messages: ask, maxTokens: 300 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ModelCallError);
    expect((failure as ModelCallError).message).toBe('Model stream error: the model ran out of memory');
  });
});

describe('a model call whose connection is lost', () => {
  it('waits until the server answers its model list again and then asks again from the start', async () => {
    const server = await serving();
    server.answerNext(cutAfter(delta({ content: 'half an ans' })), answering('the ', 'whole ', 'answer'));
    server.modelsAnswerNext(503);
    const lost: string[] = [];

    const reply = await callModel({ endpoint: endpointOf(server), messages: ask, maxTokens: 300, onConnectionLost: (why) => lost.push(why) });

    expect(reply.content).toBe('the whole answer');
    expect(lost).toHaveLength(1);
    expect(server.modelsAsked).toBe(2);
    expect(server.asked).toHaveLength(2);
    expect(server.asked[1]?.body).toEqual(server.asked[0]?.body);
  });

  it('waits for a server that refuses connections to come up and then asks it', async () => {
    const port = await freePort();
    const server = await serving({ port, listening: false });
    server.answerNext(answering('up ', 'now'));
    const lost: string[] = [];

    const reply = await callModel({
      endpoint: endpointOf(server),
      messages: ask,
      maxTokens: 300,
      onConnectionLost: (why) => {
        lost.push(why);
        void server.start();
      },
    });

    expect(lost).toEqual([expect.stringContaining('ECONNREFUSED')]);
    expect(reply.content).toBe('up now');
    expect(server.asked).toHaveLength(1);
  });

  it('stops waiting the moment the run is stopped, never asking again', async () => {
    const port = await freePort();
    const server = await serving({ port, listening: false });
    const stop = new AbortController();

    const failure = await callModel({
      endpoint: endpointOf(server),
      messages: ask,
      maxTokens: 300,
      signal: stop.signal,
      onConnectionLost: () => stop.abort(new Error('the person stopped the run')),
    }).catch((err: unknown) => err);

    expect((failure as Error).message).toBe('the person stopped the run');
    expect(server.asked).toHaveLength(0);
  });
});

describe('the queue in front of one model', () => {
  it('lets one call at a time reach the server and sends the next once the first has its answer', async () => {
    const server = await serving();
    const first = held();
    server.answerNext(first.answer, answering('second'));
    const endpoint = endpointOf(server);

    const firstAsked = server.nextAsk();
    const replies = [
      callModel({ endpoint, messages: ask, maxTokens: 300 }),
      callModel({ endpoint, messages: ask, maxTokens: 300 }),
    ];
    await firstAsked;
    expect(server.asked).toHaveLength(1);
    first.release(answering('first'));

    const [one, two] = await Promise.all(replies);
    expect([one?.content, two?.content]).toEqual(['first', 'second']);
    expect(server.mostAtOnce).toBe(1);
    expect(server.asked[1]!.at).toBeGreaterThanOrEqual(server.asked[0]!.endedAt!);
  });

  it('takes a stopped call out of the queue without it ever reaching the server', async () => {
    const server = await serving();
    const first = held();
    server.answerNext(first.answer, answering('third'));
    const endpoint = endpointOf(server);
    const stop = new AbortController();

    const firstAsked = server.nextAsk();
    const one = callModel({ endpoint, messages: ask, maxTokens: 300 });
    await firstAsked;
    const two = callModel({ endpoint, messages: ask, maxTokens: 300, signal: stop.signal }).catch((err: unknown) => err);
    const three = callModel({ endpoint, messages: ask, maxTokens: 300 });
    stop.abort(new Error('stopped while it waited'));
    expect(((await two) as Error).message).toBe('stopped while it waited');
    first.release(answering('first'));

    expect((await one).content).toBe('first');
    expect((await three).content).toBe('third');
    expect(server.asked).toHaveLength(2);
  });

  it('pauses the model for as long as a 429 says before the next call reaches it', async () => {
    const server = await serving();
    server.answerNext(refused(429, 'slow down', { 'retry-after': '2' }), answering('after the pause'));
    const endpoint = endpointOf(server);

    const failure = await callModel({ endpoint, messages: ask, maxTokens: 300 }).catch((err: unknown) => err);
    expect((failure as ModelCallError).status).toBe(429);
    const [paused] = getModelRateLimiterSnapshot(endpoint.ownerId);
    expect(paused).toMatchObject({ key: endpoint.rateLimitKey, total429: 1, lastStatus: 429 });
    expect(paused?.cooldownUntil).toBeDefined();

    const reply = await callModel({ endpoint, messages: ask, maxTokens: 300 });

    expect(reply.content).toBe('after the pause');
    expect(server.asked[1]!.at - server.asked[0]!.at).toBeGreaterThanOrEqual(2_000);
    expect(getModelRateLimiterSnapshot(endpoint.ownerId)[0]).toMatchObject({ totalRequests: 2, total429: 1, lastStatus: 200 });
  });
});

describe('a stream whose thinking goes in circles', () => {
  it('is cut off mid-stream with the reason, keeps what it thought and lets the connection go', async () => {
    const server = await serving();
    const circle = 'I should check the logs again and again. ';
    server.answerNext(leftOpen(...Array.from({ length: 200 }, () => delta({ reasoning_content: circle }))));
    const monitor = overthinkMonitor({ sensitivity: 'high' });
    const ctx = { state: createRunState() };

    const asked = server.nextAsk();
    const reply = await callModel(
      { endpoint: endpointOf(server), messages: ask, maxTokens: 300 },
      (event) => (event.kind === 'thinking' ? monitor.onThinking?.(event.text, ctx) : undefined),
    );

    expect(reply.interrupted).toEqual(expect.any(String));
    expect(reply.thinking.startsWith(circle)).toBe(true);
    expect(reply.content).toBe('');
    expect(monitor.detectors?.()).toMatchObject({ overthinking: true });
    await (await asked).closed;
  });
});
