import { describe, it, expect } from 'vitest';
import { createStreamParser } from './round-loop.js';

/**
 * Unit tests for the SSE stream parser both chat routes share.
 *
 * The fixtures are stolen from the failure modes the two routes hit in production:
 *  - frames split mid-JSON by the upstream (chat-wire.test.ts "survives a frame split mid-JSON")
 *  - tool calls arriving as fragments keyed by index (koala.ts: "reading only the first delta
 *    would execute a call with empty arguments")
 *  - reasoning and content riding the same delta on separate channels
 *
 * The parser is a pure function of chunks → events. It does no I/O and knows no envelope —
 * what the CALLER does with the events (re-encode as {delta} vs forward verbatim) is the part
 * the two routes must keep different.
 */

/** Builds one upstream SSE chunk, as the wire carries it. */
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
      {
        kind: 'toolCalls',
        calls: [{ id: 'call_1', name: 'get_logs', arguments: '{"name":"prod"}' }],
      },
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
    const events = [
      ...p.push('data: [DONE]\n\n: keep-alive comment\n\n'),
      ...p.flush(),
    ];
    expect(events).toEqual([]);
  });

  it('flushes a trailing partial line held across pushes', () => {
    const whole = delta({ content: 'tail' });
    const cut = whole.length - 4; // ends mid-JSON, no trailing newline
    const p = createStreamParser();
    const events = [...p.push(whole.slice(0, cut)), ...p.push(`${whole.slice(cut)}\n\n`), ...p.flush()];
    expect(events).toEqual([{ kind: 'content', text: 'tail' }]);
  });

  it('reports usage when the upstream carries it (stream_options.include_usage)', () => {
    const p = createStreamParser();
    const events = [
      ...p.push(sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })),
      ...p.flush(),
    ];
    expect(events).toEqual([
      { kind: 'usage', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
  });
});
