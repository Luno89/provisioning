import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { openSse, sendFrame, forwardChunk, endSse } from './sse.js';

/**
 * The SSE transport, pinned.
 *
 * These assert the exact bytes on the wire, because that is the contract: the frontend's
 * `lib/stream-delta.ts` scans for `data: ` prefixes and blank-line delimiters, and a change here
 * that looks harmless — a missing newline, a different terminator — presents as a stream that
 * hangs rather than as an error.
 */

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
    /**
     * The one that is easy to miss. nginx buffers proxied responses by default, so without this
     * every frame arrives at once when the response ends — indistinguishable from a model that
     * produced nothing until it was done.
     */
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
    // Without the second newline the browser never fires `onmessage` — an SSE event is not
    // complete until a blank line arrives, so the stream appears to hang.
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
    /**
     * `/api/chat` is a pass-through proxy: the frontend parses the provider's own frames. Decoding
     * and re-encoding here would cost a round trip per token and silently drop any field the
     * re-encoder did not know about.
     */
    const { res, written } = fakeRes();
    const raw = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n';
    forwardChunk(res, new TextEncoder().encode(raw));
    expect(written[0]).toBe(raw);
  });
});

describe('ending the stream', () => {
  it('sends [DONE] before closing', () => {
    // A client that never receives it waits for the connection to drop, which on a keep-alive
    // proxy can be a long time.
    const { res, written } = fakeRes();
    endSse(res);
    expect(written[0]).toBe('data: [DONE]\n\n');
    expect((res as unknown as { end: () => void }).end).toHaveBeenCalled();
  });
});
