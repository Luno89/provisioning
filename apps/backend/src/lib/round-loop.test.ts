import { describe, it, expect, vi } from 'vitest';
import { createStreamParser, type StreamEvent, type RoundToolCall, type RoundLoopCall } from './round-loop.js';
import { runToolRounds } from './round-loop.js';
import { PACK_SEEDS } from './pack-seeds.js';

const BUDGET = PACK_SEEDS[0]!.budget;

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (d: Record<string, unknown>) => sse({ choices: [{ delta: d }] });

describe('createStreamParser', () => {
  it('emits content deltas as they arrive', () => {
    const p = createStreamParser();
    const events = [...p.push(delta({ content: 'hello' })), ...p.flush()];
    expect(events).toEqual([{ kind: 'content', text: 'hello' }]);
  });
  it('emits reasoning under its own event kind', () => {
    const p = createStreamParser();
    const events = [...p.push(delta({ reasoning_content: 'thinking…' })), ...p.flush()];
    expect(events).toEqual([{ kind: 'reasoning', text: 'thinking…' }]);
  });
  it('keeps content and reasoning separate when one delta carries both', () => {
    const p = createStreamParser();
    const events = [
      ...p.push(delta({ reasoning_content: 'hmm', content: 'yes' })),
      ...p.flush(),
    ];
    expect(events).toEqual([
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'content', text: 'yes' },
    ]);
  });
  it('reassembles a frame split mid-JSON across chunks', () => {
    const whole = delta({ content: 'abcdef' });
    const cut = Math.floor(whole.length / 2);
    const p = createStreamParser();
    const events = [...p.push(whole.slice(0, cut)), ...p.push(whole.slice(cut)), ...p.flush()];
    expect(events).toEqual([{ kind: 'content', text: 'abcdef' }]);
  });
  it('reassembles tool-call fragments keyed by index into whole calls', () => {
    const p = createStreamParser();
    const events = [
      ...p.push(delta({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_logs', arguments: '{"na' } }] })),
      ...p.push(delta({ tool_calls: [{ index: 0, function: { arguments: 'me":"prod"}' } }] })),
      ...p.flush(),
    ];
    expect(events).toEqual([
      { kind: 'toolCalls', calls: [{ id: 'call_1', name: 'get_logs', arguments: '{"name":"prod"}' }] },
    ]);
  });
  it('keeps two tool calls on different indices separate', () => {
    const p = createStreamParser();
    const events = [
      ...p.push(delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'one', arguments: '{}' } }] })),
      ...p.push(delta({ tool_calls: [{ index: 1, id: 'b', function: { name: 'two', arguments: '{}' } }] })),
      ...p.flush(),
    ];
    expect(events).toEqual([
      { kind: 'toolCalls', calls: [{ id: 'a', name: 'one', arguments: '{}' }] },
      { kind: 'toolCalls', calls: [{ id: 'b', name: 'two', arguments: '{}' }] },
    ]);
  });
  it('ignores [DONE] and comment lines without choking', () => {
    const p = createStreamParser();
    const events = [...p.push('data: [DONE]\n\n: keep-alive comment\n\n'), ...p.flush()];
    expect(events).toEqual([]);
  });
  it('flushes a trailing partial line held across pushes', () => {
    const whole = delta({ content: 'tail' });
    const cut = whole.length - 4;
    const p = createStreamParser();
    const events = [...p.push(whole.slice(0, cut)), ...p.push(`${whole.slice(cut)}\n\n`), ...p.flush()];
    expect(events).toEqual([{ kind: 'content', text: 'tail' }]);
  });
  it('reports usage when the upstream carries it', () => {
    const p = createStreamParser();
    const events = [...p.push(sse({ choices: [], usage: { prompt_tokens: 10 } })), ...p.flush()];
    expect(events).toEqual([{ kind: 'usage', usage: { prompt_tokens: 10 } }]);
  });
});

const fakeStream = (chunks: string[]) => {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    getReader() {
      return {
        read: async () =>
          i < chunks.length
            ? { done: false, value: encoder.encode(chunks[i++]) }
            : { done: true, value: undefined },
      };
    },
  };
};
const delts = (d: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
const contentBody = (text: string) => fakeStream([delts({ content: text })]);
const toolBody = (id: string, name: string, args: string) =>
  fakeStream([delts({ tool_calls: [{ index: 0, id, function: { name, arguments: args } }] })]);

describe('runToolRounds', () => {
  it('returns content alone when the model answers without calling tools', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, body: contentBody('The answer.') });
    const result = await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 3,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      call,
      emit: vi.fn(),
      executeTool: async () => ({ content: 'tool out' }),
    });
    expect(result.answer).toBe('The answer.');
    expect(result.exhaustedRounds).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('loops: tool call → result → answer, executing the tool once', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: toolBody('t1', 'get_logs', '{"pod":"p"}') })
      .mockResolvedValueOnce({ ok: true, body: contentBody('Here are the logs.') });
    const executeTool = vi.fn().mockResolvedValue({ content: 'log lines' });

    const result = await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 3,
      messages: [{ role: 'user', content: 'check pod' }],
      tools: [],
      call,
      emit: vi.fn(),
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith({ id: 't1', name: 'get_logs', arguments: '{"pod":"p"}' });
    expect(result.answer).toBe('Here are the logs.');
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'get_logs', args: '{"pod":"p"}', ok: true, digest: 'log lines' },
    ]);
  });

  it('continues to next round even if model emits prelude text alongside tool calls on round 0', async () => {
    const mixedStream = fakeStream([
      delts({ content: 'Let me check that.' }),
      delts({ tool_calls: [{ index: 0, id: 't1', function: { name: 'list_trees', arguments: '{}' } }] }),
    ]);
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: mixedStream })
      .mockResolvedValueOnce({ ok: true, body: contentBody('Found 2 project trees.') });
    const executeTool = vi.fn().mockResolvedValue({ content: 'tree1, tree2' });

    const result = await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 3,
      messages: [{ role: 'user', content: 'list trees' }],
      tools: [],
      call,
      emit: vi.fn(),
      executeTool,
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('Found 2 project trees.');
  });

  it('flags exhausted rounds but still delivers a wrap-up answer', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: toolBody('a', 't', '{}') })
      .mockResolvedValueOnce({ ok: true, body: toolBody('b', 't', '{}') })
      .mockResolvedValueOnce({ ok: true, body: contentBody('Final wrap-up.') });
    const result = await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 2,
      messages: [{ role: 'user', content: 'go' }],
      tools: [],
      call,
      emit: vi.fn(),
      executeTool: async () => ({ content: 'r' }),
      onExhausted: 'wrap-up',
    });
    expect(result.exhaustedRounds).toBe(true);
    expect(result.answer).toBe('Final wrap-up.');
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('emits reasoning and content events as it parses each round', async () => {
    const call = vi.fn().mockResolvedValue({
      ok: true,
      body: fakeStream([delts({ reasoning_content: 'hmm' }), delts({ content: 'answer' })]),
    });
    const emit = vi.fn();
    await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 2,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      call,
      emit,
      executeTool: async () => ({ content: 'x' }),
    });
    const kinds = emit.mock.calls.map((c) => (c[0] as StreamEvent).kind);
    expect(kinds).toContain('reasoning');
    expect(kinds).toContain('content');
  });

  it('stops cleanly when the model returns no tool calls on a round', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, body: contentBody('done') });
    const result = await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 4,
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['get_logs'],
      call,
      emit: vi.fn(),
      executeTool: async () => ({ content: '' }),
    });
    expect(result.answer).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('records the assistant tool_calls message ahead of the tool result', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: toolBody('t1', 'get_logs', '{"pod":"p"}') })
      .mockResolvedValueOnce({ ok: true, body: contentBody('logs') });
    const seen: unknown[] = [];
    let messages: unknown[] = [{ role: 'user', content: 'hi' }];
    await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 3,
      messages,
      tools: [],
      call: async (req: RoundLoopCall) => {
        messages = req.messages;
        return call();
      },
      emit: vi.fn(),
      executeTool: async (c: RoundToolCall) => ({ content: 'out', digest: 'dig' }),
    });
    expect(messages).toContainEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'get_logs', arguments: '{"pod":"p"}' } }],
    });
    expect(messages).toContainEqual({ role: 'tool', tool_call_id: 't1', name: 'get_logs', content: 'out' });
  });

  it('streams events live as the body parses, before the round resolves', async () => {
    const emit = vi.fn();
    const slow = (function makeStream() {
      const encoder = new TextEncoder();
      let sent = 0;
      return {
        getReader() {
          return {
            read: async () => {
              await new Promise(r => setTimeout(r, 10));
              if (sent === 0) { sent = 1; return { done: false, value: encoder.encode(delts({ reasoning_content: 'hmm' })) }; }
              if (sent === 1) { sent = 2; return { done: false, value: encoder.encode(delts({ content: 'alive' })) }; }
              return { done: true, value: undefined };
            },
          };
        },
      };
    })();
    const call = vi.fn().mockResolvedValue({ ok: true, body: slow });
    await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 2,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      call,
      emit,
      executeTool: async () => ({ content: '' }),
    });
    const kinds = emit.mock.calls.map(c => (c[0] as { kind: string }).kind);
    expect(kinds).toContain('content');
    expect(kinds.length).toBeGreaterThanOrEqual(2);
  });

  it('calls onEnabled when a tool enables a service', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: toolBody('e', 'enable_mcp_server', '{"name":"svc"}') })
      .mockResolvedValueOnce({ ok: true, body: contentBody('done') });
    const onEnabled = vi.fn();
    await runToolRounds({ maxToolCallsPerMessage: BUDGET.record.callsPerRound, maxToolCallArgs: BUDGET.record.argChars, maxToolCallDigest: BUDGET.record.digestChars,
      maxRounds: 3,
      messages: [{ role: 'user', content: 'hi' }],
      tools: ['enable_mcp_server'],
      call,
      emit: vi.fn(),
      executeTool: async () => ({ content: 'x', enabled: 'svc' }),
      onEnabled,
    });
    expect(onEnabled).toHaveBeenCalledWith('svc');
  });
});