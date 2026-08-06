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
  interruptedReason?: string;
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
      const parsed = JSON.parse(payload);
      if (typeof parsed.interruptedReason === 'string' && parsed.interruptedReason) {
        delta.interruptedReason = parsed.interruptedReason;
      }
      const d = parsed.choices?.[0]?.delta ?? {};
      const reasoningText =
        (typeof d.reasoning_content === 'string' ? d.reasoning_content : '') ||
        (typeof d.reasoning === 'string' ? d.reasoning : '') ||
        (typeof d.thinking === 'string' ? d.thinking : '');

      if (reasoningText) delta.reasoning += reasoningText;
      if (typeof d.content === 'string') delta.content += d.content;
    } catch {
      // A frame that is not JSON is normal mid-stream; skipping beats aborting the reply.
    }
  }
  return { buffer: remainder, delta };
}

/**
 * Extracts inline <think>...</think> reasoning blocks out of text content if the engine
 * emitted thinking tags directly inside delta.content.
 */
export function splitThinkTags(text: string): { content: string; reasoning: string } {
  if (!text.includes('<think>')) {
    return { content: text, reasoning: '' };
  }
  let reasoning = '';
  let content = '';
  let cursor = 0;
  while (cursor < text.length) {
    const thinkStart = text.indexOf('<think>', cursor);
    if (thinkStart === -1) {
      content += text.slice(cursor);
      break;
    }
    content += text.slice(cursor, thinkStart);
    const thinkEnd = text.indexOf('</think>', thinkStart + 7);
    if (thinkEnd === -1) {
      reasoning += text.slice(thinkStart + 7);
      break;
    }
    reasoning += text.slice(thinkStart + 7, thinkEnd);
    cursor = thinkEnd + 8;
  }
  return { content, reasoning };
}
