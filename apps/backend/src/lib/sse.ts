import type { Response } from 'express';

/**
 * Server-sent events, written once instead of at fourteen call sites.
 *
 * ── WHY THIS IS WORTH A FILE ──
 * `res.write(`data: ${JSON.stringify(x)}\n\n`)` appears fourteen times across the two chat
 * handlers, and the three-header preamble twice. Every one of those is a chance to forget the
 * second newline — which does not fail loudly. The browser simply never fires `onmessage`, because
 * an SSE frame is not delimited until a blank line arrives, and the symptom is a stream that
 * appears to hang rather than an error anyone can see.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──
 * It does not decide the SHAPE of a frame. The two chat routes speak different protocols on
 * purpose: `/api/chat` forwards the upstream's raw OpenAI frames byte-for-byte, and
 * `/api/koala/chat` uses its own `{delta}`/`{reasoning}`/`{toolResult}` envelope. Anything that
 * unified those would be changing the wire format the frontend parses, which is a behaviour change
 * wearing a refactor's clothes. This is the transport and nothing above it.
 */

/**
 * Opens the stream.
 *
 * `X-Accel-Buffering: no` is the one that is easy to miss: nginx buffers proxied responses by
 * default, so without it every frame arrives at once when the response ends — which looks exactly
 * like a model that produced nothing until it finished.
 */
export function openSse(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

/** One JSON frame. The blank line is the delimiter — without it the client never sees the event. */
export function sendFrame(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Forwards an upstream chunk verbatim.
 *
 * For `/api/chat`, which is a pass-through proxy: the frontend's `lib/stream-delta.ts` parses
 * `choices[0].delta` straight off the provider's own frames, so re-encoding them here would mean
 * decoding and re-serialising every token for no reason — and would silently drop any field the
 * re-encoder did not know about.
 */
export function forwardChunk(res: Response, chunk: Uint8Array): void {
  res.write(Buffer.from(chunk));
}

/**
 * Ends the stream.
 *
 * `[DONE]` is the OpenAI convention and both routes send it. A client that never receives it waits
 * for the connection to close, which on a keep-alive proxy can be a long time.
 */
export function endSse(res: Response): void {
  res.write('data: [DONE]\n\n');
  res.end();
}
