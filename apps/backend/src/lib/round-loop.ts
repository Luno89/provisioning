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

/* ═════════════════ The shared round loop ═════════════ */

/** A tool call about to be executed. */
export interface RoundToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** What executing a tool produces, over and above the text to feed back. */
export interface ToolExecResult {
  /** The text appended to the turn as the tool result. */
  content: string;
  /** Whether the call succeeded. Defaults true; koala sets it from a refusal check. */
  ok?: boolean;
  /** A digest recorded in the transcript — defaults to `content` clipped. */
  digest?: string;
  /** Koala: a service enabled mid-turn widens the next round's tools. */
  enabled?: string;
  /** Koala: proposing a project / app spec. */
  proposed?: unknown;
  proposedSpec?: unknown;
}

export interface ToolRoundResult {
  answer: string;
  spoken: string;
  thinking: string;
  toolCalls: { id: string; name: string; ok: boolean; digest: string }[];
  exhaustedRounds: boolean;
  enabledNow: string[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
}

export interface RoundLoopCall {
  messages: unknown[];
  toolChoice?: 'none';
  /** Currently-enabled tool names. Grows as tools enable services mid-turn; the caller's `call`
   *  builds the request (and its tool schemas) from this. */
  tools: string[];
}

export interface RoundLoopConfig {
  maxRounds: number;
  /** The transcript so far. The loop appends assistant/tool messages and trims per round. */
  messages: unknown[];
  /** The tool names offered on the first round. */
  tools: string[];
  call: (req: RoundLoopCall) => Promise<{ ok: boolean; status?: number; body?: unknown }>;
  /** Emits raw StreamEvents plus toolCall/toolResult announcements; the caller maps to its wire. */
  emit: (frame: StreamEvent | Record<string, unknown>) => void;
  executeTool: (call: RoundToolCall) => Promise<ToolExecResult>;
  /** Per-round thread trim. Koala trims every round; the leaf loop effectively doesn't. */
  trimPerRound?: (messages: unknown[]) => unknown[];
  /** When the budget runs dry with no answer: 'wrap-up' forces a final bare answer. */
  onExhausted?: 'wrap-up';
  /** Called when a tool enabled a service; lets the caller widen next round's tools/system. */
  onEnabled?: (name: string) => void;
  maxToolCallsPerMessage?: number;
  maxToolCallArgs?: number;
  maxToolCallDigest?: number;
}

const MAX_TOOL_CALLS = 6;
const MAX_TOOL_ARGS = 400;
const MAX_TOOL_DIGEST = 2000;

/**
 * Parses one upstream body into accumulator state via the shared stream parser.
 *
 * Events are handed to `onEvent` AS THEY PARSE, not after the body completes — a reasoning model
 * produces a great deal of thinking per round, and a turn that spends eighty seconds deciding what
 * to do must show that thinking live. This is the exact regression the koala route's docblock
 * records as fixed once already; batching here would reintroduce it through the shared loop.
 */
async function pump(
  body: unknown,
  acc: { answer: string; thinking: string; calls: RoundToolCall[] },
  onEvent?: (ev: StreamEvent) => void,
): Promise<void> {
  const reader = (body as any)?.getReader?.();
  if (!reader) return;
  const parser = createStreamParser();
  const decoder = new TextDecoder();
  const handle = (ev: StreamEvent) => {
    if (ev.kind === 'content') acc.answer += ev.text;
    else if (ev.kind === 'reasoning') acc.thinking += ev.text;
    else if (ev.kind === 'toolCalls') acc.calls.push(...ev.calls);
    onEvent?.(ev);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.push(decoder.decode(value, { stream: true }))) handle(ev);
  }
  for (const ev of parser.flush()) handle(ev);
}

export async function runToolRounds(cfg: RoundLoopConfig): Promise<ToolRoundResult> {
  const {
    maxRounds, messages, call, emit, executeTool,
    trimPerRound, onExhausted,
    maxToolCallsPerMessage = MAX_TOOL_CALLS, maxToolCallArgs = MAX_TOOL_ARGS, maxToolCallDigest = MAX_TOOL_DIGEST,
  } = cfg;

  let turn = messages;
  let toolNames = [...(cfg.tools ?? [])];
  let answer = '';
  let thinking = '';
  let spoken = '';
  let exhaustedRounds = false;
  const toolCalls: ToolRoundResult['toolCalls'] = [];
  const enabledNow: string[] = [];
  const proposedTrees: unknown[] = [];
  const proposedSpecs: unknown[] = [];

  for (let round = 0; round < maxRounds; round++) {
    if (answer) break; // answered on a previous round
    exhaustedRounds = round === maxRounds - 1;
    const sent = trimPerRound ? trimPerRound(turn) : turn;

    const step = await call({ messages: sent, tools: toolNames });
    if (!step.ok || !step.body) break;

    const acc = { answer: '', thinking: '', calls: [] as RoundToolCall[] };
    // Events stream live via cfg.emit inside pump — the reader watches thinking and prose arrive.
    await pump(step.body, acc, cfg.emit);
    if (acc.answer) {
      spoken = acc.answer;
      answer = acc.answer;
    }
    // A round that called tools must record the assistant's tool_calls message before its tool
    // results — the API rejects a `tool` message that has no `tool_calls` entry before it.
    if (acc.calls.length > 0) {
      turn.push({
        role: 'assistant',
        content: null,
        tool_calls: acc.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
    }
    for (const c of acc.calls) {
      cfg.emit({ kind: 'toolCall', id: c.id, name: c.name, args: c.arguments.slice(0, maxToolCallArgs) });
      const out = await executeTool(c);
      const ok = out.ok ?? true;
      const digest = (out.digest ?? out.content).slice(0, maxToolCallDigest);
      if (toolCalls.length < maxToolCallsPerMessage) {
        toolCalls.push({ id: c.id, name: c.name, ok, digest });
      }
      cfg.emit({ kind: 'toolResult', id: c.id, ok, digest });
      if (out.enabled && !enabledNow.includes(out.enabled)) enabledNow.push(out.enabled);
      if (out.enabled) {
        cfg.onEnabled?.(out.enabled);
        if (!toolNames.includes(out.enabled)) toolNames.push(out.enabled);
      }
      if (out.proposed) proposedTrees.push(out.proposed);
      if (out.proposedSpec) proposedSpecs.push(out.proposedSpec);
      turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: out.content });
    }
  }

  // Exhausted with no answer: force a bare wrap-up round.
  if (exhaustedRounds && !answer && onExhausted === 'wrap-up') {
    const last = await call({ messages: turn, tools: toolNames, toolChoice: 'none' });
    if (last.ok && last.body) {
      const acc = { answer: '', thinking: '', calls: [] as RoundToolCall[] };
      await pump(last.body, acc, cfg.emit);
      if (acc.answer) answer = acc.answer;
    }
  }

  return { answer, spoken, thinking, toolCalls, exhaustedRounds, enabledNow, proposedTrees, proposedSpecs };
}
