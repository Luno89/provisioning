import { describe, it, expect } from 'vitest';
import { withConversationNotice } from './conversation-notice.js';
import type { Conversation } from './conversations.js';

const conversation: Conversation = {
  id: 'c1', ownerId: 'u1', title: 'Chat', messages: [{ role: 'user', content: 'hi', at: 'then' }],
  createdAt: 'then', updatedAt: 'then',
};

describe('withConversationNotice', () => {
  it('appends a notice message, keeping the existing ones', () => {
    const out = withConversationNotice(conversation, 'Accepted the "X" tree.', 'now');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[1]).toEqual({ role: 'assistant', content: 'Accepted the "X" tree.', at: 'now', notice: true });
  });

  it('bumps updatedAt to the notice time', () => {
    const out = withConversationNotice(conversation, 'text', 'now');
    expect(out.updatedAt).toBe('now');
  });

  it('does not mutate the original conversation', () => {
    withConversationNotice(conversation, 'text', 'now');
    expect(conversation.messages).toHaveLength(1);
  });
});
