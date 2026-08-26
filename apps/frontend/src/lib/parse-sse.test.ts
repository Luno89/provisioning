import { describe, it, expect } from 'vitest';
import { parseSseStream } from '../lib/parse-sse.js';

/**
 * RED: the unified SSE parser.
 *
 * The backend emits unified frames as SSE: `data: {"type":"content","delta":"..."}`
 * This parser extracts them one by one from the raw stream chunks.
 * Pure function, no fetch — just the framing logic.
 */

describe('parseSseStream — unified wire frames from raw SSE chunks', () => {
  it('splits a single-frame chunk', () => {
    const chunks = ['data: {"type":"content","delta":"Hello"}\n\n'];
    const frames = [...parseSseStream(chunks)];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: 'content', delta: 'Hello' });
  });

  it('accumulates across multiple chunk boundaries', () => {
    const chunks = [
      'data: {"type":"content","delta":"He',
      'llo"}\n\n',
    ];
    const frames = [...parseSseStream(chunks)];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: 'content', delta: 'Hello' });
  });

  it('handles multiple frames in one chunk', () => {
    const chunks = [
      'data: {"type":"content","delta":"He"}\n\n' +
      'data: {"type":"thinking","delta":"let me"}\n\n',
    ];
    const frames = [...parseSseStream(chunks)];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({ type: 'content', delta: 'He' });
    expect(frames[1]).toEqual({ type: 'thinking', delta: 'let me' });
  });

  it('ignores [DONE] and empty lines', () => {
    const chunks = [
      'data: {"type":"content","delta":"Hi"}\n\n' +
      'data: [DONE]\n\n',
    ];
    const frames = [...parseSseStream(chunks)];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: 'content', delta: 'Hi' });
  });

  it('ignores lines without data: prefix', () => {
    const chunks = ['retry: 2000\n\n' + 'data: {"type":"content","delta":"X"}\n\n'];
    const frames = [...parseSseStream(chunks)];
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ type: 'content', delta: 'X' });
  });
});