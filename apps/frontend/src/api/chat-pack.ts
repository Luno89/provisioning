
import { api } from './client.js';

export const chatPackKeys = {
  conversations: () => ['chat-pack-conversations'] as const,
  conversation: (id: string) => ['chat-pack-conversation', id] as const,
};

export interface ChatConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string | undefined;
  reasoning?: string | undefined;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: string;
    ok: boolean;
    digest: string;
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
  treeId?: string | undefined;
  mcpServers?: string[] | undefined;
  projectId?: string | undefined;
  messages?: ChatConversationMessage[] | undefined;
}

export type Conversation = ChatConversation;

export const listChatConversations = (): Promise<ChatConversation[]> =>
  api.get<ChatConversation[]>('/conversations').then((r) => r.data);

export const getChatConversation = (id: string): Promise<ChatConversation | null> =>
  api.get<ChatConversation>(`/conversations/${id}`).then((r) => r.data);

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
  patch: { modelId?: string | null | undefined; agentSlug?: string | null | undefined },
): Promise<ChatConversation> =>
  api.patch<ChatConversation>(`/conversations/${id}`, patch).then((r) => r.data);
