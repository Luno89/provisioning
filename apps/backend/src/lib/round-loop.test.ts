import { describe, it, expect, vi } from 'vitest';
import { createStreamParser, type StreamEvent } from './round-loop.js';
import { runToolRounds } from './round-loop.js';

/* ═════════════ PARSER (C1) ═════════════ */
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

/* ═════════════════ ROUND LOOP (C2) ═════════════ */

/** A fake upstream stream that yields chunks from an array (the shape of `Response.body`). */
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
    const result = await runToolRounds({
      maxRounds: 3,
      messages: [{ role: 'user', content: 'hi' }],
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

    const result = await runToolRounds({
      maxRounds: 3,
      messages: [{ role: 'user', content: 'check pod' }],
      call,
      emit: vi.fn(),
      executeTool,
    });

    expect(executeTool).toHaveBeenCalledWith({ id: 't1', name: 'get_logs', arguments: '{"pod":"p"}' });
    expect(result.answer).toBe('Here are the logs.');
    expect(result.toolCalls).toEqual([{ id: 't1', name: 'get_logs', ok: true, digest: 'log lines' }]);
  });

  it('flags exhausted rounds but still delivers a wrap-up answer', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, body: toolBody('a', 't', '{}') })
      .mockResolvedValueOnce({ ok: true, body: toolBody('b', 't', '{}') })
      .mockResolvedValueOnce({ ok: true, body: contentBody('Final wrap-up.') });
    const result = await runToolRounds({
      maxRounds: 2,
      messages: [{ role: 'user', content: 'go' }],
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
    await runToolRounds({
      maxRounds: 2,
      messages: [{ role: 'user', content: 'hi' }],
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
    const result = await runToolRounds({
      maxRounds: 4,
      messages: [{ role: 'user', content: 'hi' }],
      call,
      emit: vi.fn(),
      executeTool: async () => ({ content: '' }),
    });
    expect(result.answer).toBe('done');
    expect(call).toHaveBeenCalledTimes(1);
  });
});