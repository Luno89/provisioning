
import { api, postStream, type StreamResponse } from './client.js';

export interface ChatPackTurnRequest {
  conversationId?: string | undefined;
  message: string;
  sessionId?: string | undefined;
  modelId?: string | undefined;
}

export const chatPackKeys = {
  conversations: () => ['chat-pack-conversations'] as const,
  conversation: (id: string) => ['chat-pack-conversation', id] as const,
};

export const openChatPackStream = (
  body: ChatPackTurnRequest,
  signal?: AbortSignal,
): Promise<StreamResponse> =>
  postStream('/chat-pack', body, signal);

export interface ChatConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  at?: string | undefined;
  reasoning?: string | undefined;
  enabled?: string[] | undefined;
  toolCalls?: Array<{
    id: string;
    name: string;
    args: string;
    ok: boolean;
    digest: string;
  }> | undefined;
  notice?: boolean | undefined;
  handoff?: boolean | undefined;
}

export interface ProposedEscalationRecord {
  id: string;
  reason: string;
  scope: 'cluster-read' | 'cluster-admin';
  namespaces?: string[] | undefined;
  proposedAt: string;
  status: 'pending' | 'accepted' | 'denied';
  acceptedAt?: string | undefined;
  deniedAt?: string | undefined;
}

export interface ChatConversation {
  id: string;
  title: string;
  ownerId?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  messageCount?: number | undefined;
  /** The engine this conversation was last sent on; absent means it follows pack and default. */
  modelId?: string | null | undefined;
  messages?: ChatConversationMessage[] | undefined;
  proposedTrees?: any[] | undefined;
  proposedSpecs?: any[] | undefined;
  isEscalated?: boolean | undefined;
  escalatedScope?: 'cluster-read' | 'cluster-admin' | undefined;
  escalatedNamespaces?: string[] | undefined;
  proposedEscalations?: ProposedEscalationRecord[] | undefined;
  proposedSecretRequests?: ProposedSecretRequestRecord[] | undefined;
}

export interface ProposedSecretRequestRecord {
  id: string;
  key: string;
  label?: string | undefined;
  description: string;
  projectId?: string | undefined;
  status: 'pending' | 'fulfilled' | 'dismissed';
  secretReference?: string | undefined;
  requestedAt: string;
  fulfilledAt?: string | undefined;
  dismissedAt?: string | undefined;
}

export type Conversation = ChatConversation;

export const listChatConversations = (): Promise<ChatConversation[]> =>
  api.get<ChatConversation[]>('/chat-pack/conversations').then((r) => r.data);

export const getChatConversation = (id: string): Promise<ChatConversation | null> =>
  api.get<ChatConversation>(`/chat-pack/conversations/${id}`).then((r) => r.data);

export const createChatConversation = (title?: string): Promise<ChatConversation> =>
  api.post<ChatConversation>('/chat-pack/conversations', { title }).then((r) => r.data);

export const deleteChatConversation = (id: string): Promise<void> =>
  api.delete(`/chat-pack/conversations/${id}`).then(() => undefined);

export const acceptSpecProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/specs/${proposalId}/accept`, {})
    .then((r) => r.data);

export const acceptTreeProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/trees/${proposalId}/accept`, {})
    .then((r) => r.data);

export const acceptEscalationProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/escalations/${proposalId}/accept`, {})
    .then((r) => r.data);

export const denyEscalationProposal = <T,>(conversationId: string, proposalId: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/escalations/${proposalId}/deny`, {})
    .then((r) => r.data);

export const submitSecretRequest = <T,>(conversationId: string, requestId: string, value: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/secrets/${requestId}/submit`, { value })
    .then((r) => r.data);

export const dismissSecretRequest = <T,>(conversationId: string, requestId: string): Promise<T> =>
  api.post<T>(`/chat-pack/conversations/${conversationId}/secrets/${requestId}/dismiss`, {})
    .then((r) => r.data);