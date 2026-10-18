import type { ModelReach } from '@koala/harness-types';
import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';

export type MessageAuthor = { kind: 'person'; id: string } | { kind: 'agent'; slug: string } | { kind: 'platform' };

export type NoticeKind = 'preview-ready' | 'release-live' | 'release-failed' | 'tree-quiet' | 'leaf-failed' | 'secret-needed' | 'workspace-ready' | 'workspace-waiting' | 'workspace-failed' | 'client-database-awaited' | 'alert-firing' | 'alert-resolved';
export type NoticeAction = 'open-preview' | 'open-app' | 'cut-over' | 'open-tree' | 'open-story' | 'enter-secret' | 'open-workspace' | 'open-settings' | 'open-monitoring';

export interface ConversationNotice {
  key: string;
  kind: NoticeKind;
  text: string;
  refs: { projectId?: string | undefined; releaseId?: string | undefined; treeId?: string | undefined; branchId?: string | undefined; leafId?: string | undefined; requestId?: string | undefined; deploymentId?: string | undefined; clusterId?: string | undefined };
  line?: string | undefined;
  actions: NoticeAction[];
}

export const NOTICE_PREFIX = 'From the platform, not the person: ';

export function noticeMessage(notice: ConversationNotice, at: string): ConversationMessage {
  return { role: 'notice', author: { kind: 'platform' }, content: notice.text, at, notice };
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'notice';
  author?: MessageAuthor;
  notice?: ConversationNotice;
  content: string;
  reasoning?: string;
  at: string;

  toolCalls?: ConversationToolCall[];
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
  modelReach?: ModelReach | undefined;
  treeId?: string | undefined;
  projectId?: string | undefined;
  kind?: 'channel' | 'item' | undefined;
  leafId?: string | undefined;
  branchId?: string | undefined;
  mcpServers?: string[] | undefined;
  platformNamespaces?: string[] | undefined;
  compaction?: { summary: string; through: number } | undefined;
  liveTurn?: { runId: string; startedAt: string } | undefined;
  allowedTools?: string[] | undefined;
  machineSessions?: Record<string, string> | undefined;
  createdAt: string;
  updatedAt: string;
}

export class NoNoteToAskError extends Error {
  constructor(at: string) {
    super(`There is no posted message from ${at} in this conversation that Koala has not been asked about.`);
    this.name = 'NoNoteToAskError';
  }
}

export const noteAt = (conversation: Pick<Conversation, 'messages'> | undefined, at: string, content: string): number =>
  conversation?.messages.findIndex((message) => message.role === 'user' && !message.runId && message.at === at && message.content === content) ?? -1;

export function openTurn(existing: Conversation | undefined, turn: { ownerId: string; conversationId: string; runId: string; message: string; now: string; asks?: string | undefined }): Conversation {
  const base: Conversation = existing ?? { id: turn.conversationId, ownerId: turn.ownerId, title: titleFrom(turn.message), messages: [], createdAt: turn.now, updatedAt: turn.now };
  if (base.messages.some((message) => message.runId === turn.runId)) return base;
  const note = turn.asks ? noteAt(base, turn.asks, turn.message) : -1;
  if (turn.asks && note === -1) throw new NoNoteToAskError(turn.asks);
  const messages = note === -1
    ? [...base.messages, { role: 'user' as const, author: { kind: 'person' as const, id: turn.ownerId }, content: turn.message, at: turn.now, runId: turn.runId }]
    : base.messages.map((message, index) => (index === note ? { ...message, runId: turn.runId } : message));
  return {
    ...base,
    messages,
    liveTurn: { runId: turn.runId, startedAt: turn.now },
    updatedAt: turn.now,
  };
}

export function closeTurn(conversation: Conversation, runId: string, reply: Omit<ConversationMessage, 'role' | 'runId'>, now: string): Conversation {
  const { liveTurn, ...rest } = conversation;
  const still = liveTurn && liveTurn.runId !== runId ? { liveTurn } : {};
  if (conversation.messages.some((message) => message.role === 'assistant' && message.runId === runId)) return { ...rest, ...still };
  return { ...rest, ...still, messages: [...conversation.messages, { role: 'assistant', ...reply, runId }], updatedAt: now };
}

export type ChatItem = { kind: 'story'; leafId: string } | { kind: 'feature'; branchId: string };

export const itemChatIdFor = (item: ChatItem): string => (item.kind === 'story' ? `story-${item.leafId}` : `feature-${item.branchId}`);

export const channelIdFor = (projectId: string): string => `channel-${projectId}`;

export const MAX_POSTED = 20_000;

export function personMessage(ownerId: string, content: string, at: string): ConversationMessage | { problem: string } {
  const text = String(content ?? '').trim();
  if (!text) return { problem: 'the message is empty' };
  if (text.length > MAX_POSTED) return { problem: `a message is at most ${MAX_POSTED} characters` };
  return { role: 'user', author: { kind: 'person', id: ownerId }, content: text, at };
}

export const mentionsKoala = (text: string): boolean => /(^|\s)@koala\b/i.test(text);

export type ChatKind = Conversation['kind'];

export const postedNotToYou = (who: string): string => `${who} posted, not to you: `;

export const SOMEONE = 'Someone';

export function heardAs(message: Pick<ConversationMessage, 'role' | 'author' | 'content' | 'runId'>, kind: ChatKind, names: Readonly<Record<string, string>>): string {
  if (!kind || message.role !== 'user' || message.author?.kind !== 'person') return message.content;
  const who = names[message.author.id] ?? SOMEONE;
  if (kind === 'channel' && !message.runId) return `${postedNotToYou(who)}${message.content}`;
  return `${who}: ${message.content}`;
}

export const peopleIn = (messages: readonly Pick<ConversationMessage, 'author'>[]): string[] =>
  [...new Set(messages.flatMap((message) => (message.author?.kind === 'person' ? [message.author.id] : [])))];

export function chatFraming(chat: { kind: ChatKind; item?: 'story' | 'feature' | undefined }, who: string): string | undefined {
  if (chat.kind === 'channel') {
    return [
      'This is the project\'s channel, where people talk about its work with each other.',
      'You answer only when someone asks you, with @koala or Ask Koala.',
      `Messages posted here that were not to you are in the conversation as "<who> posted, not to you:". Read them for what is being discussed and by whom, but do not act on them unless you are asked to.`,
      `${who} is asking you now.`,
    ].join(' ');
  }
  if (chat.kind === 'item') {
    const subject = chat.item ?? 'story';
    return `This is the chat about the ${subject} below. Every message here is to you; each says who wrote it. ${who} is talking with you now.`;
  }
  return undefined;
}

const MAX_TITLE = 120;

export function titleFrom(message: string): string {
  const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}
