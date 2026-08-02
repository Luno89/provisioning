import { describe, it, expect } from 'vitest';
import { extractUsage, UsageScanner } from './token-usage.js';

/**
 * The fixture is the real closing chunk from the live TabbyAPI deployment serving Qwen3 — timing
 * fields and all, since those are TabbyAPI extensions the parser has to ignore rather than choke on.
 */
const REAL_FINAL_CHUNK =
  'data: {"id":"chatcmpl-5b50","object":"chat.completion.chunk","created":1785686121,' +
  '"choices":[{"index":0,"delta":{},"finish_reason":"length"}],' +
  '"usage":{"prompt_tokens":11,"prompt_time":1.52,"prompt_tokens_per_sec":7.24,' +
  '"completion_tokens":4,"completion_time":0.93,"total_tokens":15,"total_time":2.48},' +
  '"model":"turboderp-qwen3-6-27b-exl3-5-00bpw"}\n\ndata: [DONE]\n\n';

const contentChunk = (text: string) =>
  `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}}}]}\n\n`;

describe('extractUsage', () => {
  it('reads the real TabbyAPI closing chunk', () => {
    expect(extractUsage(REAL_FINAL_CHUNK)).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });
  });

  it('returns undefined when the stream carried no usage', () => {
    // The normal case for a server that does not support include_usage. Recording nothing is
    // correct; recording 0 would silently under-report spend against a budget.
    expect(extractUsage(contentChunk('hello') + 'data: [DONE]\n\n')).toBeUndefined();
  });

  it('takes the LAST usage object when several appear', () => {
    const first = 'data: {"usage":{"total_tokens":5}}\n\n';
    const last = 'data: {"usage":{"total_tokens":50}}\n\n';
    expect(extractUsage(first + last)?.totalTokens).toBe(50);
  });

  it('ignores a usage object with no usable total', () => {
    expect(extractUsage('data: {"usage":{"prompt_tokens":10}}\n\n')).toBeUndefined();
    expect(extractUsage('data: {"usage":{"total_tokens":0}}\n\n')).toBeUndefined();
    expect(extractUsage('data: {"usage":{"total_tokens":"lots"}}\n\n')).toBeUndefined();
  });

  it('survives malformed frames without losing a later valid one', () => {
    expect(extractUsage('data: {not json}\n\n' + REAL_FINAL_CHUNK)?.totalTokens).toBe(15);
  });

  it('handles empty input', () => {
    expect(extractUsage('')).toBeUndefined();
    expect(() => extractUsage('data:\n\n')).not.toThrow();
  });
});

describe('UsageScanner', () => {
  it('finds usage split across chunk boundaries', () => {
    // The same failure mode that dropped content tokens before stream-delta.ts buffered properly:
    // the network does not respect frame boundaries.
    const scanner = new UsageScanner();
    const cut = Math.floor(REAL_FINAL_CHUNK.length / 2);
    scanner.push(REAL_FINAL_CHUNK.slice(0, cut));
    scanner.push(REAL_FINAL_CHUNK.slice(cut));
    expect(scanner.result()?.totalTokens).toBe(15);
  });

  it('finds usage after a long body without buffering the whole response', () => {
    const scanner = new UsageScanner();
    for (let i = 0; i < 500; i++) scanner.push(contentChunk(`token ${i} `));
    scanner.push(REAL_FINAL_CHUNK);
    expect(scanner.result()?.totalTokens).toBe(15);
  });

  it('reports nothing when the stream had no usage', () => {
    const scanner = new UsageScanner();
    scanner.push(contentChunk('hi'));
    scanner.push('data: [DONE]\n\n');
    expect(scanner.result()).toBeUndefined();
  });

  it('keeps a usage value found early even if later chunks have none', () => {
    // The tail window slides, so a value must be retained rather than re-derived from the buffer.
    const scanner = new UsageScanner();
    scanner.push(REAL_FINAL_CHUNK);
    for (let i = 0; i < 100; i++) scanner.push(contentChunk('trailing '));
    expect(scanner.result()?.totalTokens).toBe(15);
  });
});
