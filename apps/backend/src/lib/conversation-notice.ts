import type { Conversation, ConversationMessage } from './conversations.js';

/** Mirrors branch-notice.ts's withNotice — same shape, for a Conversation instead of a Branch. */
export function withConversationNotice(
  conversation: Conversation,
  text: string,
  now = new Date().toISOString(),
): Conversation {
  const message: ConversationMessage = { role: 'assistant', content: text, at: now, notice: true };
  return { ...conversation, messages: [...conversation.messages, message], updatedAt: now };
}
