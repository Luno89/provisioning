export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  at: string;

  toolCalls?: ConversationToolCall[];
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
  createdAt: string;
  updatedAt: string;
}

const MAX_TITLE = 120;

export function titleFrom(message: string): string {
  const flat = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > MAX_TITLE ? `${flat.slice(0, MAX_TITLE - 1)}…` : flat;
}
