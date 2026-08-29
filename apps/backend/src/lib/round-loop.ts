
export type StreamEvent =
  | { kind: 'content'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'toolCalls'; calls: { id: string; name: string; arguments: string }[] }
  | { kind: 'usage'; usage: Record<string, unknown> };

export interface StreamParser {
  push(chunk: string): StreamEvent[];
  flush(): StreamEvent[];
}

export function createStreamParser(): StreamParser {
  const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
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
    } catch { /* ignored */ }
    return events;
  };

  let highestStarted = -1;
  const drainCompleted = (): StreamEvent[] => {
    const events: StreamEvent[] = [];
    for (const index of [...callsByIndex.keys()].sort((a, b) => a - b)) {
      if (index > highestStarted) {
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

export interface RoundToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolExecResult {
  content: string;
  ok?: boolean;
  digest?: string;
  enabled?: string;
  proposed?: unknown;
  proposedSpec?: unknown;
  proposedEscalation?: unknown;
  proposedSecretRequest?: unknown;
}

export interface ToolRoundResult {
  answer: string;
  spoken: string;
  thinking: string;
  toolCalls: { id: string; name: string; args: string; ok: boolean; digest: string }[];
  exhaustedRounds: boolean;
  enabledNow: string[];
  proposedTrees: unknown[];
  proposedSpecs: unknown[];
  proposedEscalations: unknown[];
  proposedSecretRequests: unknown[];
}

export interface RoundLoopCall {
  messages: unknown[];
  toolChoice?: 'none';
  tools: string[];
}

export interface RoundLoopConfig {
  maxRounds: number;
  messages: unknown[];
  tools: string[];
  call: (req: RoundLoopCall) => Promise<{ ok: boolean; status?: number; body?: unknown }>;
  emit: (frame: StreamEvent | Record<string, unknown>) => void;
  executeTool: (call: RoundToolCall) => Promise<ToolExecResult>;
  trimPerRound?: (messages: unknown[]) => unknown[];
  onExhausted?: 'wrap-up';
  onEnabled?: (name: string) => void;
  maxToolCallsPerMessage?: number;
  maxToolCallArgs?: number;
  maxToolCallDigest?: number;
}

const MAX_TOOL_CALLS = 6;
const MAX_TOOL_ARGS = 400;
const MAX_TOOL_DIGEST = 2000;

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
  const proposedEscalations: unknown[] = [];
  const proposedSecretRequests: unknown[] = [];

  for (let round = 0; round < maxRounds; round++) {
    if (answer) break;
    exhaustedRounds = round === maxRounds - 1;
    const sent = trimPerRound ? trimPerRound(turn) : turn;

    const step = await call({ messages: sent, tools: toolNames });
    if (!step.ok || !step.body) break;

    const acc = { answer: '', thinking: '', calls: [] as RoundToolCall[] };
    await pump(step.body, acc, cfg.emit);
    if (acc.thinking) {
      thinking += acc.thinking;
    }

    if (acc.calls.length > 0) {
      turn.push({
        role: 'assistant',
        content: acc.answer || null,
        tool_calls: acc.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
      });
      if (acc.answer) {
        spoken += (spoken ? '\n' : '') + acc.answer;
      }
    } else if (acc.answer) {
      spoken += (spoken ? '\n' : '') + acc.answer;
      answer = acc.answer;
      break;
    } else if (!acc.thinking) {
      break;
    }
    for (const c of acc.calls) {
      cfg.emit({ kind: 'toolCall', id: c.id, name: c.name, args: c.arguments.slice(0, maxToolCallArgs) });
      const out = await executeTool(c);
      const ok = out.ok ?? true;
      const digest = (out.digest ?? out.content).slice(0, maxToolCallDigest);
      if (toolCalls.length < maxToolCallsPerMessage) {
        toolCalls.push({ id: c.id, name: c.name, args: c.arguments.slice(0, maxToolCallArgs), ok, digest });
      }
      cfg.emit({ kind: 'toolResult', id: c.id, ok, digest });
      if (out.enabled && !enabledNow.includes(out.enabled)) enabledNow.push(out.enabled);
      if (out.enabled) {
        cfg.onEnabled?.(out.enabled);
        if (!toolNames.includes(out.enabled)) toolNames.push(out.enabled);
      }
      if (out.proposed) proposedTrees.push(out.proposed);
      if (out.proposedSpec) proposedSpecs.push(out.proposedSpec);
      if (out.proposedEscalation) proposedEscalations.push(out.proposedEscalation);
      if (out.proposedSecretRequest) proposedSecretRequests.push(out.proposedSecretRequest);
      turn.push({ role: 'tool', tool_call_id: c.id, name: c.name, content: out.content });
    }
  }

  if (exhaustedRounds && !answer && onExhausted === 'wrap-up') {
    const last = await call({ messages: turn, tools: toolNames, toolChoice: 'none' });
    if (last.ok && last.body) {
      const acc = { answer: '', thinking: '', calls: [] as RoundToolCall[] };
      await pump(last.body, acc, cfg.emit);
      if (acc.answer) answer = acc.answer;
    }
  }

  return { answer, spoken, thinking, toolCalls, exhaustedRounds, enabledNow, proposedTrees, proposedSpecs, proposedEscalations, proposedSecretRequests };
}
