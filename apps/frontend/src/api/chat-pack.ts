import type { ModelReach } from '@koala/harness-types'
import type { Artifact, ChildSteps } from '@koala/agent-engine/procedure';

import { api } from './client.js';

export const chatPackKeys = {
  conversations: () => ['chat-pack-conversations'] as const,
  conversation: (id: string) => ['chat-pack-conversation', id] as const,
  context: (id: string) => ['chat-pack-conversation', id, 'context'] as const,
};

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `ConversationNotice` and `MessageAuthor` in apps/backend/src/engine/lib/conversations.ts.
 */
export type NoticeKind = 'hub-main-conflict' | 'preview-ready' | 'release-live' | 'release-failed' | 'tree-quiet' | 'leaf-failed' | 'secret-needed' | 'workspace-ready' | 'workspace-waiting' | 'workspace-failed' | 'client-database-awaited' | 'alert-firing' | 'alert-resolved'
export type NoticeAction = 'open-preview' | 'open-app' | 'cut-over' | 'open-tree' | 'open-story' | 'enter-secret' | 'open-workspace' | 'open-settings' | 'open-monitoring'

export interface ConversationNotice {
  key: string;
  kind: NoticeKind;
  text: string;
  refs: { projectId?: string | undefined; releaseId?: string | undefined; treeId?: string | undefined; branchId?: string | undefined; leafId?: string | undefined; requestId?: string | undefined; deploymentId?: string | undefined; clusterId?: string | undefined };
  line?: string | undefined;
  actions: NoticeAction[];
}

export type MessageAuthor = { kind: 'person'; id: string } | { kind: 'agent'; slug: string } | { kind: 'platform' }

export interface ChatConversationMessage {
  role: 'user' | 'assistant' | 'notice';
  author?: MessageAuthor | undefined;
  authorName?: string | undefined;
  attachments?: import('../features/files').MessageAttachment[] | undefined;
  notice?: ConversationNotice | undefined;
  content: string;
  at?: string | undefined;
  runId?: string | undefined;
  reasoning?: string | undefined;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: string;
    ok: boolean;
    digest: string;
    artifacts?: Artifact[] | undefined;
    child?: ChildSteps | undefined;
  }> | undefined;
  interruptedReason?: string | undefined;
}

export interface ChatConversation {
  id: string;
  title: string;
  ownerId?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  messageCount?: number | undefined;
  /** The engine this conversation runs on; absent means it follows pack and default. */
  modelId?: string | null | undefined;
  /**
   * The agent slug this conversation runs turns on (e.g. 'koala', or an owner agent slug).
   * Absent means the default agent. Patched by the chat surface; preserved across engine turns.
   */
  agentSlug?: string | null | undefined;
  modelReach?: ModelReach | undefined;
  autoMode?: boolean | undefined;
  kind?: 'channel' | 'item' | undefined;
  treeId?: string | undefined;
  leafId?: string | undefined;
  branchId?: string | undefined;
  mcpServers?: string[] | undefined;
  projectId?: string | undefined;
  liveTurn?: { runId: string; startedAt: string } | undefined;
  messages?: ChatConversationMessage[] | undefined;
}

export type Conversation = ChatConversation;

export const listChatConversations = (): Promise<ChatConversation[]> =>
  api.get<ChatConversation[]>('/conversations').then((r) => r.data);

export const getChatConversation = (id: string): Promise<ChatConversation | null> =>
  api.get<ChatConversation>(`/conversations/${id}`).then((r) => r.data);

export interface ConversationContext {
  given: Record<string, string>
  text: string
}

export const getConversationContext = (id: string): Promise<ConversationContext> =>
  api.get<ConversationContext>(`/conversations/${encodeURIComponent(id)}/context`).then((r) => r.data);

export interface ConversationBinding {
  treeId?: string | undefined;
  projectId?: string | undefined;
}

export const createChatConversation = (title?: string, binding: ConversationBinding = {}): Promise<ChatConversation> =>
  api.post<ChatConversation>('/conversations', {
    title,
    ...(binding.treeId ? { treeId: binding.treeId } : {}),
    ...(binding.projectId ? { projectId: binding.projectId } : {}),
  }).then((r) => r.data);

export const deleteChatConversation = (id: string): Promise<void> =>
  api.delete(`/conversations/${id}`).then(() => undefined);

/**
 * Patch chat-owned metadata on a conversation — the running agent and the pinned model. The
 * engine's save preserves stored fields it does not write itself, so these ride the doc and
 * survive engine turns.
 */
export const patchChatConversation = (
  id: string,
  patch: { modelId?: string | null | undefined; agentSlug?: string | null | undefined; modelReach?: ModelReach | undefined },
): Promise<ChatConversation> =>
  api.patch<ChatConversation>(`/conversations/${id}`, patch).then((r) => r.data);
