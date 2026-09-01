
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  at: string;
  enabled?: string[];

  toolCalls?: ConversationToolCall[];

  notice?: true;

  handoff?: true;
}

export interface ConversationToolCall {
  id: string;
  name: string;
  args: string;
  ok: boolean;
  digest: string;
}

export const MAX_TOOL_CALL_ARGS = 300;
export const MAX_TOOL_CALL_DIGEST = 300;
export const MAX_TOOL_CALLS_PER_MESSAGE = 40;

export interface ProposedTree {
  id: string;
  name: string;
  type: string;
  goal: string;
  /**
   * What the conversation established, carried across the boundary.
   *
   * The goal alone is one or two sentences, and everything else Koala worked out — the user's own
   * words, what it found already running, what was ruled out — used to be dropped here, leaving
   * the planner to start cold and sometimes plan to rebuild something that already existed.
   */
  brief?: string;
  context?: string;
  openQuestions?: string;
  conversationId?: string;
  proposedAt: string;
  treeId?: string;
}

export interface ProposedSpec {
  id: string;
  spec: unknown;
  proposedAt: string;
  replaces?: boolean;
  acceptedAt?: string;
}

export interface ProposedEscalation {
  id: string;
  reason: string;
  scope: 'cluster-read' | 'cluster-admin';
  namespaces?: string[] | undefined;
  proposedAt: string;
  status: 'pending' | 'accepted' | 'denied';
  acceptedAt?: string | undefined;
  deniedAt?: string | undefined;
}

export interface ProposedSecretRequest {
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

export interface Conversation {
  id: string;
  ownerId: string;
  title: string;
  messages: ConversationMessage[];
  sessionId?: string;
  /**
   * The engine this conversation was last sent on, so reopening it does not silently move to
   * whatever the account defaults to today. Absent means it follows the pack and the default.
   */
  modelId?: string | undefined;
  enabledMcp?: string[];
  proposedTrees?: ProposedTree[];
  proposedSpecs?: ProposedSpec[];
  isEscalated?: boolean | undefined;
  escalatedScope?: 'cluster-read' | 'cluster-admin' | undefined;
  escalatedNamespaces?: string[] | undefined;
  proposedEscalations?: ProposedEscalation[] | undefined;
  proposedSecretRequests?: ProposedSecretRequest[] | undefined;
  createdAt: string;
  updatedAt: string;
}

const MAX_TITLE = 120;

export function titleFrom(message: string): string {
  const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}

export function enabledForSession(
  conversation: Pick<Conversation, 'sessionId' | 'enabledMcp'>,
  sessionId: string | undefined,
): string[] {
  if (!sessionId || conversation.sessionId !== sessionId) return [];
  return [...(conversation.enabledMcp ?? [])];
}

export function withEnabled(
  conversation: Conversation,
  sessionId: string | undefined,
  server: string,
): Conversation {
  const current = enabledForSession(conversation, sessionId);
  if (current.includes(server)) return conversation;
  return {
    ...conversation,
    ...(sessionId ? { sessionId } : {}),
    enabledMcp: [...current, server],
    updatedAt: new Date().toISOString(),
  };
}
