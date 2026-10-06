import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  at: string;

  toolCalls?: ConversationToolCall[];
  /** The run whose turn this message belongs to: the user's message as it opened the turn, the reply as it closed it. */
  runId?: string;
  /** Set when this message is a salvaged partial reply — the turn was stopped or failed mid-stream
   * rather than completing normally. Names why, so it reads as "cut short" rather than a finished
   * answer, both live and after a reload. */
  interruptedReason?: string;
}

export interface ConversationToolCall {
  id: string;
  name: string;
  args: string;
  ok: boolean;
  digest: string;
  artifacts?: Artifact[];
  /** For a hand-off: what the run it started did, step by step. */
  child?: ChildSteps;
}

export const MAX_TOOL_CALL_ARGS = 300;
export const MAX_TOOL_CALL_DIGEST = 300;
export const MAX_TOOL_CALLS_PER_MESSAGE = 40;

export interface Conversation {
  id: string;
  ownerId: string;
  title: string;
  messages: ConversationMessage[];
  /**
   * The engine this conversation was last sent on, so reopening it does not silently move to
   * whatever the account defaults to today. Absent means it follows the pack and the default.
   */
  modelId?: string | undefined;
  /**
   * The agent slug this conversation runs turns on ("koala" for the default chat persona).
   * Absent means the default agent. The engine's save path preserves stored fields such as this
   * rather than replacing the document: chat-owned metadata rides the conversation doc.
   */
  agentSlug?: string | undefined;
  treeId?: string | undefined;
  projectId?: string | undefined;
  mcpServers?: string[] | undefined;
  platformNamespaces?: string[] | undefined;
  /** The turn under way: its run, until the run saves its reply. Its log holds what it has done so far. */
  liveTurn?: { runId: string; startedAt: string } | undefined;
  createdAt: string;
  updatedAt: string;
}

/** The conversation with the person's message saved and the turn marked under way, before its run starts. Opening the same run's turn again changes nothing. */
export function openTurn(existing: Conversation | undefined, turn: { ownerId: string; conversationId: string; runId: string; message: string; now: string }): Conversation {
  const base: Conversation = existing ?? { id: turn.conversationId, ownerId: turn.ownerId, title: titleFrom(turn.message), messages: [], createdAt: turn.now, updatedAt: turn.now };
  if (base.messages.some((message) => message.runId === turn.runId)) return base;
  return {
    ...base,
    messages: [...base.messages, { role: 'user', content: turn.message, at: turn.now, runId: turn.runId }],
    liveTurn: { runId: turn.runId, startedAt: turn.now },
    updatedAt: turn.now,
  };
}

/** The conversation with a turn's reply saved and the turn no longer under way. A reply already saved for the run is kept as it is. */
export function closeTurn(conversation: Conversation, runId: string, reply: Omit<ConversationMessage, 'role' | 'runId'>, now: string): Conversation {
  const { liveTurn, ...rest } = conversation;
  const still = liveTurn && liveTurn.runId !== runId ? { liveTurn } : {};
  if (conversation.messages.some((message) => message.role === 'assistant' && message.runId === runId)) return { ...rest, ...still };
  return { ...rest, ...still, messages: [...conversation.messages, { role: 'assistant', ...reply, runId }], updatedAt: now };
}

const MAX_TITLE = 120;

export function titleFrom(message: string): string {
  const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}
