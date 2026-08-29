import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { openSse, sendFrame, forwardChunk, endSse } from './sse.js';

const fakeRes = () => {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  return {
    written,
    headers,
    res: {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      flushHeaders: vi.fn(),
      write: (c: string | Buffer) => { written.push(c.toString()); return true; },
      end: vi.fn(),
    } as unknown as Response,
  };
};

describe('opening the stream', () => {
  it('sets the four headers a proxied stream needs', () => {
    const { res, headers } = fakeRes();
    openSse(res);
    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers.Connection).toBe('keep-alive');
    expect(headers['X-Accel-Buffering']).toBe('no');
  });

  it('flushes them, so the client sees the stream open before any token', () => {
    const { res } = fakeRes();
    openSse(res);
    expect((res as unknown as { flushHeaders: () => void }).flushHeaders).toHaveBeenCalled();
  });
});

describe('a frame', () => {
  it('ends with a BLANK line, which is what delimits it', () => {
    const { res, written } = fakeRes();
    sendFrame(res, { delta: 'hi' });
    expect(written[0]).toBe('data: {"delta":"hi"}\n\n');
  });

  it('serialises whatever it is given', () => {
    const { res, written } = fakeRes();
    sendFrame(res, { toolResult: { id: 't1', ok: true } });
    expect(written[0]).toBe('data: {"toolResult":{"id":"t1","ok":true}}\n\n');
  });
});

describe('forwarding a chunk', () => {
  it('passes the upstream bytes through unchanged', () => {
    const { res, written } = fakeRes();
    const raw = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    forwardChunk(res, new TextEncoder().encode(raw));
    expect(written[0]).toBe(raw);
  });
});

describe('ending the stream', () => {
  it('sends [DONE] before closing', () => {
    const { res, written } = fakeRes();
    endSse(res);
    expect(written[0]).toBe('data: [DONE]\n\n');
    expect((res as unknown as { end: () => void }).end).toHaveBeenCalled();
  });
});
