/**
 * Pulls token usage out of an OpenAI-compatible SSE stream as it passes through.
 *
 * Streaming responses normally omit usage entirely — it arrives only when the request asks for it
 * via `stream_options: { include_usage: true }`, and then only in the FINAL chunk, after the last
 * content delta. So metering means watching the whole stream go past rather than reading a field
 * off a response body.
 *
 * Verified against the live TabbyAPI deployment: the closing chunk carries
 * `"usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15, ...}` alongside
 * timing fields that are TabbyAPI extensions and deliberately ignored here.
 *
 * Kept pure and separate because it is scanning attacker-adjacent text — model output the platform
 * did not author — and because a metering bug is invisible until a budget is wrong.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Scans SSE text for a usage object.
 *
 * Returns the LAST one found: some servers emit usage on several chunks with running totals, and
 * the final value is the complete one. Returns undefined when the stream carried none, which is
 * the normal case for a server that does not support `include_usage` — metering then records
 * nothing rather than guessing a number.
 */
export function extractUsage(sse: string): TokenUsage | undefined {
  let found: TokenUsage | undefined;

  for (const line of sse.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const usage = JSON.parse(payload)?.usage;
      if (!usage || typeof usage !== 'object') continue;

      const total = Number(usage.total_tokens);
      const prompt = Number(usage.prompt_tokens);
      const completion = Number(usage.completion_tokens);
      // A usage object without a usable total is worse than none: recording 0 would silently
      // under-report spend against a budget rather than reporting nothing.
      if (!Number.isFinite(total) || total <= 0) continue;

      found = {
        totalTokens: total,
        promptTokens: Number.isFinite(prompt) ? prompt : 0,
        completionTokens: Number.isFinite(completion) ? completion : 0,
      };
    } catch {
      // Partial or non-JSON frames are normal mid-stream.
    }
  }

  return found;
}

/**
 * Accumulates across chunk boundaries, because a usage object can be split by the network exactly
 * like any other frame — the same failure that dropped content tokens before lib/stream-delta.ts
 * buffered properly.
 *
 * Only the tail is retained: usage arrives at the very end, so holding the whole response would
 * mean buffering an entire generation in memory to read fifty bytes off the back of it.
 */
export class UsageScanner {
  private tail = '';
  private usage: TokenUsage | undefined;

  /** Roughly two SSE frames — comfortably more than a usage chunk, far less than a response. */
  private static readonly TAIL_LIMIT = 8192;

  push(chunk: string): void {
    this.tail = (this.tail + chunk).slice(-UsageScanner.TAIL_LIMIT);
    const found = extractUsage(this.tail);
    if (found) this.usage = found;
  }

  result(): TokenUsage | undefined {
    return this.usage;
  }
}

/**
 * Accumulates assistant content from an SSE stream.
 *
 * Only `delta.content` — deliberately NOT `delta.reasoning_content`. A reasoning model thinks out
 * loud before answering, and its thinking regularly contains draft JSON it then discards. Parsing
 * proposals out of reasoning would create leaves the model considered and rejected.
 *
 * Unlike UsageScanner this keeps everything, because a proposal block sits at the end of a reply
 * whose length is not known in advance.
 */
export class ContentScanner {
  private buffer = '';
  private text = '';

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // Frames split across network chunks, so the trailing partial line is carried over.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        if (typeof delta?.content === 'string') this.text += delta.content;
      } catch {
        // Partial or non-JSON frames are normal mid-stream.
      }
    }
  }

  result(): string {
    return this.text;
  }
}
