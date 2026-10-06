import type { EngineEvent } from '@koala/agent-engine';
import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';
import type { ConversationToolCall } from './conversations.js';

/** One numbered write to a turn's log: the events of the turn's runs, in the order they happened. */
export interface TurnLogEntry {
  turnId: string;
  ownerId: string;
  seq: number;
  events: EngineEvent[];
  at: string;
}

export const TURN_LOG_RETENTION_SECONDS = 7 * 24 * 60 * 60;

type Delta = Extract<EngineEvent, { type: 'content' | 'thinking' }>;

const isDelta = (event: EngineEvent): event is Delta => event.type === 'content' || event.type === 'thinking';

/** Joins runs of text deltas from the same run and node into one event, so a log holds a few writes a second rather than one per token. */
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

/**
 * What a turn's top-level run had said and done, rebuilt from its log: the reply to keep when the run
 * ended without saving it. Only the turn's own run speaks in the reply; a hand-off's run is what its
 * call's result carries.
 */
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
