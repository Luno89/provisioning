import { describe, it, expect, vi } from 'vitest';
import * as client from '../api/client.js';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof client>()),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('chat-pack conversation helpers', () => {
  it('calls conversation endpoints correctly', async () => {
    const { listChatConversations, getChatConversation, createChatConversation, deleteChatConversation } = await import('../api/chat-pack.js');
    
    vi.mocked(client.api.get).mockResolvedValueOnce({ data: [{ id: 'conv-1' }] });
    const list = await listChatConversations();
    expect(client.api.get).toHaveBeenCalledWith('/conversations');
    expect(list).toEqual([{ id: 'conv-1' }]);

    vi.mocked(client.api.get).mockResolvedValueOnce({ data: { id: 'conv-1', title: 'Hello' } });
    const conv = await getChatConversation('conv-1');
    expect(client.api.get).toHaveBeenCalledWith('/conversations/conv-1');
    expect(conv).toEqual({ id: 'conv-1', title: 'Hello' });

    vi.mocked(client.api.post).mockResolvedValueOnce({ data: { id: 'conv-2' } });
    const created = await createChatConversation('New Title');
    expect(client.api.post).toHaveBeenCalledWith('/conversations', { title: 'New Title' });
    expect(created).toEqual({ id: 'conv-2' });

    vi.mocked(client.api.delete).mockResolvedValueOnce({ data: { success: true } });
    await deleteChatConversation('conv-2');
    expect(client.api.delete).toHaveBeenCalledWith('/conversations/conv-2');
  });
});