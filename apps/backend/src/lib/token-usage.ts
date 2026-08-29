
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

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
      if (!Number.isFinite(total) || total <= 0) continue;

      found = {
        totalTokens: total,
        promptTokens: Number.isFinite(prompt) ? prompt : 0,
        completionTokens: Number.isFinite(completion) ? completion : 0,
      };
    } catch {
    }
  }

  return found;
}

export class UsageScanner {
  private tail = '';
  private usage: TokenUsage | undefined;

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

export class ContentScanner {
  private buffer = '';
  private text = '';

  push(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
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
      }
    }
  }

  result(): string {
    return this.text;
  }
}
