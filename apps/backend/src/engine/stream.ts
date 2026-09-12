export type StreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; call: StreamToolCall }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'finish'; reason: string };

export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamParser {
  push(chunk: string): StreamEvent[];
  flush(): StreamEvent[];
}

export function createStreamParser(): StreamParser {
  const callsByIndex = new Map<number, StreamToolCall>();
  const emitted = new Set<number>();
  let buffer = '';
  let highestStarted = -1;

  const parseLine = (line: string): StreamEvent[] => {
    const events: StreamEvent[] = [];
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return events;

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return events;

    try {
      const parsed = JSON.parse(payload);
      const choice = parsed?.choices?.[0];
      const delta = choice?.delta;

      const thinking = delta?.reasoning_content ?? delta?.reasoning;
      if (thinking) events.push({ kind: 'thinking', text: String(thinking) });
      if (delta?.content) events.push({ kind: 'content', text: String(delta.content) });

      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number(call?.index ?? 0);
          const existing = callsByIndex.get(index) ?? { id: '', name: '', arguments: '' };
          callsByIndex.set(index, {
            id: call?.id || existing.id,
            name: call?.function?.name || existing.name,
            arguments: existing.arguments + (call?.function?.arguments ?? ''),
          });
          if (index > highestStarted) highestStarted = index;
        }
      }

      if (parsed?.usage) events.push({ kind: 'usage', usage: parsed.usage });
      if (choice?.finish_reason) events.push({ kind: 'finish', reason: String(choice.finish_reason) });
    } catch { /* ignored */ }

    return events;
  };

  const drainCompleted = (): StreamEvent[] => {
    const events: StreamEvent[] = [];
    for (const [index, call] of [...callsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      if (index < highestStarted && !emitted.has(index)) {
        emitted.add(index);
        events.push({ kind: 'toolCall', call });
      }
    }
    return events;
  };

  return {
    push(chunk: string): StreamEvent[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const events: StreamEvent[] = [];
      for (const line of lines) events.push(...parseLine(line));
      events.push(...drainCompleted());
      return events;
    },

    flush(): StreamEvent[] {
      const events: StreamEvent[] = [];
      if (buffer) {
        events.push(...parseLine(buffer));
        buffer = '';
      }
      for (const [index, call] of [...callsByIndex.entries()].sort((a, b) => a[0] - b[0])) {
        if (!emitted.has(index)) {
          emitted.add(index);
          events.push({ kind: 'toolCall', call });
        }
      }
      return events;
    },
  };
}
