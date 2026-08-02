/**
 * Incremental parser for an OpenAI-compatible SSE stream.
 *
 * Extracted because this logic has already produced two distinct bugs, both invisible until a real
 * model was streaming:
 *
 *   1. SSE frames split across chunk boundaries. Parsing each network chunk independently drops
 *      tokens at arbitrary points in long replies.
 *   2. Reasoning models emit `delta.reasoning_content` before any `delta.content`. Reading only
 *      `content` showed a spinner through the entire thinking phase — and with a small max_tokens
 *      budget, nothing at all, which is indistinguishable from a broken deployment. Confirmed
 *      against TabbyAPI serving Qwen3: 35 reasoning frames, then one content frame.
 */

export interface StreamDelta {
  content: string;
  reasoning: string;
}

/**
 * Feeds a decoded chunk in and returns the text found in it, plus whatever trailing partial line
 * must be carried into the next call. The caller owns the buffer, so this stays pure.
 */
export function consumeChunk(buffer: string, chunk: string): { buffer: string; delta: StreamDelta } {
  const combined = buffer + chunk;
  const lines = combined.split('\n');
  // The final element is either an empty string (chunk ended on a newline) or a partial line that
  // must not be parsed yet. Either way it becomes the next buffer.
  const remainder = lines.pop() ?? '';

  const delta: StreamDelta = { content: '', reasoning: '' };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const d = JSON.parse(payload).choices?.[0]?.delta ?? {};
      if (typeof d.content === 'string') delta.content += d.content;
      if (typeof d.reasoning_content === 'string') delta.reasoning += d.reasoning_content;
    } catch {
      // A frame that is not JSON is normal mid-stream; skipping beats aborting the reply.
    }
  }
  return { buffer: remainder, delta };
}
