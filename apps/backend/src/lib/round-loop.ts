/**
 * The streaming tool round-loop both chat routes share.
 *
 * ── WHY THIS EXISTS ──
 * `routes/koala.ts` and `routes/chat.ts` each carried a private copy of the same machine: a
 * streaming loop over `/chat/completions` that parses SSE deltas, reassembles tool calls, executes
 * them and feeds results back until the model answers or the budget dies. The koala.ts docblock
 * recorded the consolidation as "a SEPARATE, later change" — this file is that change.
 *
 * ── WHAT IS SHARED AND WHAT STAYS APART ──
 * Shared here: SSE line reassembly (frames split mid-JSON are normal), tool-call fragment
 * reassembly keyed by index, and the round structure itself.
 *
 * Deliberately NOT here: the wire envelope. Koala re-encodes upstream frames as
 * `{delta}/{reasoning}/{toolCall}/{toolResult}`; `/api/chat` forwards provider frames verbatim.
 * That difference is pinned on both sides by `routes/chat-wire.test.ts` and is the whole reason
 * this file emits EVENTS and never frames — what the caller does with an event is the part the
 * two routes must keep different.
 */

/** One thing the upstream said, before any envelope decision. */
export type StreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'toolCalls'; calls: { id: string; name: string; arguments: string }[] }
  | { kind: 'usage'; usage: Record<string, unknown> };

/**
 * Incremental SSE parser for OpenAI-shaped chat streams.
 *
 * Push raw network chunks; collect events. Frames split across chunk boundaries are held until
 * complete, which is the failure both routes hit in production and chat-wire.test.ts pins.
 */
export interface StreamParser {
  push(chunk: string): StreamEvent[];
  /** Emits anything a final chunk left incomplete. Call once, at end of stream. */
  flush(): StreamEvent[];
}

export function createStreamParser(): StreamParser {
  // Tool calls arrive as fragments keyed by index — reassembled here, since reading only the
  // first delta would execute a call with empty arguments.
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
  /** Indices already emitted, so a call is reported once, when its arguments complete. */
  const emitted = new Set<number>();
  let buffer = '';

  const parseLine = (line: string): StreamEvent[] => {
    const events: StreamEvent[] = [];
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return events;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') return events;

    try {
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta;

      if (delta?.reasoning_content) events.push({ kind: 'reasoning', text: delta.reasoning_content });
      if (delta?.content) events.push({ kind: 'content', text: delta.content });

      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number(call?.index ?? 0);
          const existing = callsByIndex.get(index) ?? { id: '', name: '', args: '' };
          callsByIndex.set(index, {
            id: call?.id || existing.id,
            name: call?.function?.name || existing.name,
            args: existing.args + (call?.function?.arguments ?? ''),
          });
        }
      }

      if (parsed?.usage) {
        events.push({ kind: 'usage', usage: parsed.usage });
      }
    } catch {
      // A partial frame; the next chunk completes it.
    }
    return events;
  };

  /**
   * A call is emitted when the stream ends, or when a LATER index arrives — arguments for one
   * call stream contiguously on their own index, so a new index proves the previous one finished.
   * Emitting on id+name alone would fire with arguments half-arrived, which is exactly the
   * "executes a call with empty arguments" failure this reassembly exists to prevent.
   */
  let highestStarted = -1;
  const drainCompleted = (): StreamEvent[] => {
    const events: StreamEvent[] = [];
    for (const index of [...callsByIndex.keys()].sort((a, b) => a - b)) {
      if (index > highestStarted) {
        // Everything below the newest started index is finished.
        highestStarted = index;
        for (const [done, call] of callsByIndex) {
          if (done < index && !emitted.has(done)) {
            emitted.add(done);
            events.push({ kind: 'toolCalls', calls: [{ id: call.id, name: call.name, arguments: call.args }] });
          }
        }
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
      events.push(...drainCompleted());
      for (const [index, call] of callsByIndex) {
        if (!emitted.has(index)) {
          emitted.add(index);
          events.push({ kind: 'toolCalls', calls: [{ id: call.id, name: call.name, arguments: call.args }] });
        }
      }
      return events;
    },
  };
}
