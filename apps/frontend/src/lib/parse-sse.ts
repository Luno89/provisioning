
export function* parseSseStream(chunks: Iterable<string>): Generator<UnifiedFrame> {
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        yield JSON.parse(payload) as UnifiedFrame;
      } catch {
        continue;
      }
    }
  }
  if (buffer.trim().startsWith('data: ')) {
    const payload = buffer.trim().slice(6).trim();
    if (payload && payload !== '[DONE]') {
      try {
        yield JSON.parse(payload) as UnifiedFrame;
      } catch { /* ignored */ }
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