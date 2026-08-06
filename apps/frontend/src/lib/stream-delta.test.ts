import { describe, it, expect } from 'vitest';
import { consumeChunk, splitThinkTags } from './stream-delta.js';

const frame = (delta: Record<string, string>) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;

/** Drives the parser the way the component does: one buffer, many chunks. */
function run(chunks: string[]) {
  let buffer = '';
  let content = '';
  let reasoning = '';
  for (const chunk of chunks) {
    const r = consumeChunk(buffer, chunk);
    buffer = r.buffer;
    content += r.delta.content;
    reasoning += r.delta.reasoning;
  }
  return { content, reasoning };
}

describe('consumeChunk', () => {
  it('collects content across frames', () => {
    expect(run([frame({ content: 'Hel' }), frame({ content: 'lo' })]).content).toBe('Hello');
  });

  it('collects reasoning_content separately from content', () => {
    // The bug this pins. TabbyAPI serving Qwen3 emits 35 reasoning frames and then one content
    // frame; reading only `content` renders a spinner for the whole thinking phase.
    const r = run([
      frame({ reasoning_content: "Here's a" }),
      frame({ reasoning_content: ' thinking process:' }),
      frame({ content: '\n\nOK' }),
    ]);
    expect(r.reasoning).toBe("Here's a thinking process:");
    expect(r.content).toBe('\n\nOK');
  });

  it('reassembles a frame split across chunk boundaries', () => {
    // The other bug. Network chunks do not respect SSE frame boundaries, and parsing each one
    // independently silently drops tokens partway through long replies.
    const whole = frame({ content: 'unbroken' });
    const cut = Math.floor(whole.length / 2);
    expect(run([whole.slice(0, cut), whole.slice(cut)]).content).toBe('unbroken');
  });

  it('handles a split that lands mid-JSON-string', () => {
    const whole = frame({ content: 'abcdefghij' });
    const idx = whole.indexOf('abcdef') + 3;
    expect(run([whole.slice(0, idx), whole.slice(idx)]).content).toBe('abcdefghij');
  });

  it('ignores [DONE] and blank frames', () => {
    expect(run([frame({ content: 'x' }), 'data: [DONE]\n\n', '\n\n']).content).toBe('x');
  });

  it('skips a malformed frame without losing the rest of the stream', () => {
    const r = run([frame({ content: 'a' }), 'data: {not json}\n\n', frame({ content: 'b' })]);
    expect(r.content).toBe('ab');
  });

  it('ignores non-string deltas rather than concatenating "undefined"', () => {
    expect(run(['data: {"choices":[{"delta":{"content":null}}]}\n\n']).content).toBe('');
    expect(run(['data: {"choices":[]}\n\n']).content).toBe('');
  });

  it('supports delta.reasoning and delta.thinking fields from various LLM engines', () => {
    const r1 = run([frame({ reasoning: 'Ollama thought' }), frame({ content: 'Answer' })]);
    expect(r1.reasoning).toBe('Ollama thought');
    expect(r1.content).toBe('Answer');

    const r2 = run([frame({ thinking: 'llama.cpp thought' }), frame({ content: 'Answer' })]);
    expect(r2.reasoning).toBe('llama.cpp thought');
    expect(r2.content).toBe('Answer');
  });

  it('correctly splits inline <think> tags using splitThinkTags', () => {
    const input = '<think>User is greeting me</think>Hello! How are you?';
    const res = splitThinkTags(input);
    expect(res.reasoning).toBe('User is greeting me');
    expect(res.content).toBe('Hello! How are you?');
  });

  it('extracts interruptedReason from SSE frame', () => {
    const res = consumeChunk('', 'data: {"interruptedReason":"N-gram loop detected"}\n\n');
    expect(res.delta.interruptedReason).toBe('N-gram loop detected');
  });
});
