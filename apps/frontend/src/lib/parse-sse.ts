/* ═══════════════ Unified SSE parser ═══════════════ */

/**
 * Parse raw SSE chunks into unified frames.
 *
 * The backend emits: `data: {"type":"content","delta":"..."}\n\n`
 * This extracts each `data:` line, skips `[DONE]`, and yields the parsed JSON.
 *
 * Pure generator — no fetch, no side effects.
 */
export function* parseSseStream(chunks: Iterable<string>): Generator<UnifiedFrame> {
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // last line may be incomplete

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload) as UnifiedFrame;
      } catch {
        // Malformed frame — skip rather than throw mid-stream
        continue;
      }
    }
  }
  // Flush any remaining
  if (buffer.trim().startsWith('data: ')) {
    const payload = buffer.trim().slice(6).trim();
    if (payload && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload) as UnifiedFrame;
      } catch {
        // ignore
      }
    }
  }
}

export type UnifiedFrame =
  | { type: 'content'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'toolAnnounce'; payload: { id: string; name: string; args: string } }
  | { type: 'toolResult'; payload: { id: string; ok: boolean; digest?: string } }
  | { type: 'enabled'; payload: string[] }
  | { type: 'proposedTree'; payload: any }
  | { type: 'proposedSpec'; payload: any }
  | { type: 'proposedEscalation'; payload: any }
  | { type: 'proposedSecretRequest'; payload: any }
  | { type: 'plan'; payload: any }
  | { type: 'usage'; payload: any }
  | { type: 'interrupted'; payload: any }
  | { type: string; payload?: any };