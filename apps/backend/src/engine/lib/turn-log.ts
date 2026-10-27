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
  const { inputs: _inputs, outputs, ...summary } = trace;
  const external = trace.kind === 'external-agent' ? outputs as { identity?: { title?: unknown; name?: unknown }; model?: { name?: unknown } } | undefined : undefined;
  const agentName = external?.identity?.title ?? external?.identity?.name;
  const chose = trace.kind === 'choose-model'
    ? (outputs as { binding?: { label?: unknown } } | undefined)?.binding?.label
    : typeof external?.model?.name === 'string' ? `${typeof agentName === 'string' ? `${agentName} · ` : ''}${external.model.name}` : undefined;
  return typeof chose === 'string' ? { ...summary, model: chose } : summary;
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

export const procedureRanIn = (entries: readonly Pick<TurnLogEntry, 'events'>[], procedureId: string): boolean =>
  entries.some((entry) => entry.events.some((event) => event.type === 'run.started' && (event as { loopId?: string }).loopId === procedureId));

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

export const MARK_MESSAGE_CHARS = 300;

export const ASK_MARKS = ['run.started', 'run.finished', 'notice', 'tool.result'] as const;

export interface RunMark {
  type: string;
  runId: string;
  parentRunId?: string | undefined;
  agentId?: string | undefined;
  callId?: string | undefined;
  tool?: string | undefined;
  level?: string | undefined;
  message?: string | undefined;
}

export interface WaitingAsk {
  runId: string;
  callId: string;
  tool: string;
  message: string;
  agent?: string | undefined;
  leafId?: string | undefined;
}

const askedTool = (mark: RunMark): string => mark.tool ?? /wants to run (\S+) on /.exec(mark.message ?? '')?.[1] ?? 'a tool';

export function unansweredAsks(marks: readonly RunMark[], leaves: readonly { id: string; runId?: string | undefined }[]): WaitingAsk[] {
  const parents = new Map<string, string>();
  const agents = new Map<string, string>();
  const finished = new Set<string>();
  const answered = new Set<string>();
  const asked = new Map<string, RunMark>();
  for (const mark of marks) {
    if (mark.type === 'run.started') {
      if (mark.parentRunId) parents.set(mark.runId, mark.parentRunId);
      if (mark.agentId) agents.set(mark.runId, mark.agentId);
    } else if (mark.type === 'run.finished') finished.add(mark.runId);
    else if (mark.type === 'tool.result' && mark.callId) answered.add(`${mark.runId} ${mark.callId}`);
    else if (mark.type === 'notice' && mark.level === 'warn' && mark.callId) asked.set(`${mark.runId} ${mark.callId}`, mark);
  }
  const leafOfRun = new Map(leaves.filter((leaf) => leaf.runId).map((leaf) => [leaf.runId!, leaf.id]));
  const storyOf = (runId: string): string | undefined => {
    for (let at: string | undefined = runId; at; at = parents.get(at)) {
      const leafId = leafOfRun.get(at);
      if (leafId) return leafId;
    }
    return undefined;
  };
  return [...asked.entries()]
    .filter(([key, mark]) => !answered.has(key) && !finished.has(mark.runId))
    .map(([, mark]) => {
      const agent = agents.get(mark.runId);
      const leafId = storyOf(mark.runId);
      const tool = askedTool(mark);
      return { runId: mark.runId, callId: mark.callId!, tool, message: mark.message ?? `${agent ?? 'A run'} wants to run ${tool}`, ...(agent ? { agent } : {}), ...(leafId ? { leafId } : {}) };
    });
}
