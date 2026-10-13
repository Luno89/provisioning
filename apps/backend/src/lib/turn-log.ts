import type { EngineEvent } from '@koala/agent-engine';
import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';
import type { ConversationToolCall } from './conversations.js';

export interface TurnLogEntry {
  turnId: string;
  ownerId: string;
  seq: number;
  events: EngineEvent[];
  at: string;
}

export const TURN_LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60;

export function tracedSummary(trace: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { inputs: _inputs, outputs: _outputs, ...summary } = trace;
  return summary;
}

export function withTraceSummaries(events: readonly EngineEvent[]): EngineEvent[] {
  return events.map((event) => (event.type === 'node.traced' ? { ...event, trace: tracedSummary(event.trace) } : event));
}

type Delta = Extract<EngineEvent, { type: 'content' | 'thinking' }>;

const isDelta = (event: EngineEvent): event is Delta => event.type === 'content' || event.type === 'thinking';

export function coalesce(events: readonly EngineEvent[]): EngineEvent[] {
  const joined: EngineEvent[] = [];
  for (const event of events) {
    const last = joined[joined.length - 1];
    if (last && isDelta(last) && isDelta(event) && last.type === event.type && last.runId === event.runId && last.nodeId === event.nodeId) {
      joined[joined.length - 1] = { ...last, delta: last.delta + event.delta };
    } else {
      joined.push(event);
    }
  }
  return joined;
}

export interface LoggedReply {
  content: string;
  reasoning: string;
  toolCalls: ConversationToolCall[];
}

export function replyFromLog(entries: readonly TurnLogEntry[], turnId: string): LoggedReply {
  let content = '';
  let reasoning = '';
  const calls = new Map<string, ConversationToolCall>();
  for (const event of [...entries].sort((a, b) => a.seq - b.seq).flatMap((entry) => entry.events)) {
    if (event.runId !== turnId) continue;
    if (event.type === 'content') content += event.delta;
    else if (event.type === 'thinking') reasoning += event.delta;
    else if (event.type === 'tool.called') calls.set(event.callId, { id: event.callId, name: event.name, args: event.args, ok: false, digest: 'it did not finish — the run ended first' });
    else if (event.type === 'tool.result') {
      const called = calls.get(event.callId);
      if (!called) continue;
      const { artifacts, child } = event as { artifacts?: Artifact[]; child?: ChildSteps };
      calls.set(event.callId, { ...called, ok: event.ok, digest: event.digest, ...(artifacts?.length ? { artifacts } : {}), ...(child ? { child } : {}) });
    }
  }
  return { content, reasoning, toolCalls: [...calls.values()] };
}

export function runsUnder<T extends Pick<TurnLogEntry, 'seq' | 'events'>>(entries: readonly T[], rootRunId: string): { entries: T[]; through: number } {
  const ids = new Set([rootRunId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const entry of entries) {
      for (const event of entry.events) {
        const started = event as { type: string; runId: string; parentRunId?: string };
        if (started.type === 'run.started' && started.parentRunId && ids.has(started.parentRunId) && !ids.has(started.runId)) {
          ids.add(started.runId);
          grew = true;
        }
      }
    }
  }
  const kept = entries
    .map((entry) => ({ ...entry, events: withTraceSummaries(entry.events.filter((event) => ids.has((event as { runId: string }).runId))) }))
    .filter((entry) => entry.events.length > 0);
  return { entries: kept, through: entries.reduce((last, entry) => Math.max(last, entry.seq), 0) };
}
