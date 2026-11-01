import { ignore } from '@koala/engine-core/failures';

export type StreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; call: StreamToolCall }
  | { kind: 'usage'; usage: Record<string, unknown> }
  | { kind: 'finish'; reason: string }
  | { kind: 'error'; error: string };

export interface StreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamParser {
  push(chunk: string): StreamEvent[];
  flush(): StreamEvent[];
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonOf(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch (failure) {
    return ignore('a data line that is not JSON carries nothing to read, and the stream says how it ended in its own error and finish events')(failure);
  }
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

    const chunk = recordOf(jsonOf(payload));
    if (!chunk) return events;
    if (chunk.error) {
      const message = typeof chunk.error === 'string'
        ? chunk.error
        : (recordOf(chunk.error)?.message ?? JSON.stringify(chunk.error));
      events.push({ kind: 'error', error: String(message) });
      return events;
    }

    const choice = Array.isArray(chunk.choices) ? recordOf(chunk.choices[0]) : undefined;
    const delta = recordOf(choice?.delta);

    const thinking = delta?.reasoning_content ?? delta?.reasoning;
    if (thinking) events.push({ kind: 'thinking', text: String(thinking) });
    if (delta?.content) events.push({ kind: 'content', text: String(delta.content) });

    if (Array.isArray(delta?.tool_calls)) {
      for (const raw of delta.tool_calls as unknown[]) {
        const call = recordOf(raw);
        const fn = recordOf(call?.function);
        const index = Number(call?.index ?? 0);
        const existing = callsByIndex.get(index) ?? { id: '', name: '', arguments: '' };
        callsByIndex.set(index, {
          id: call?.id ? String(call.id) : existing.id,
          name: fn?.name ? String(fn.name) : existing.name,
          arguments: existing.arguments + String(fn?.arguments ?? ''),
        });
        if (index > highestStarted) highestStarted = index;
      }
    }

    const usage = recordOf(chunk.usage);
    if (usage) events.push({ kind: 'usage', usage });
    if (choice?.finish_reason) events.push({ kind: 'finish', reason: String(choice.finish_reason) });

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
