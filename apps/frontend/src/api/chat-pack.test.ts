import { describe, it, expect, vi } from 'vitest';
import { openChatPackStream } from '../api/chat-pack.js';
import * as client from '../api/client.js';

/**
 * RED: the unified chat-pack client.
 *
 * Calls POST /api/chat-pack/:packId with a turn request and returns the SSE response.
 * Mocked at the module boundary (client.postStream) — same pattern as KoalaChat.test.
 */

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof client>()),
  postStream: vi.fn(),
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('openChatPackStream — unified persona-pack turn', () => {
  it('posts to the pack-specific route with the message', async () => {
    const mockRes = new Response(new ReadableStream(), { status: 200 });
    vi.mocked(client.postStream).mockResolvedValue(mockRes as any);

    await openChatPackStream({ packId: 'researcher', conversationId: 'c1', message: 'hi' });

    expect(client.postStream).toHaveBeenCalledWith(
      '/chat-pack/researcher',
      { conversationId: 'c1', message: 'hi' },
      undefined,
    );
  });

  it('includes sessionId when provided', async () => {
    const mockRes = new Response(new ReadableStream(), { status: 200 });
    vi.mocked(client.postStream).mockResolvedValue(mockRes as any);

    await openChatPackStream({ packId: 'koala', conversationId: 'c1', message: 'hi', sessionId: 's1' });

    expect(client.postStream).toHaveBeenCalledWith(
      '/chat-pack/koala',
      { conversationId: 'c1', message: 'hi', sessionId: 's1' },
      undefined,
    );
  });

  it('includes modelId when provided', async () => {
    const mockRes = new Response(new ReadableStream(), { status: 200 });
    vi.mocked(client.postStream).mockResolvedValue(mockRes as any);

    await openChatPackStream({ packId: 'koala', conversationId: 'c1', message: 'hi', modelId: 'm1' });

    expect(client.postStream).toHaveBeenCalledWith(
      '/chat-pack/koala',
      { conversationId: 'c1', message: 'hi', modelId: 'm1' },
      undefined,
    );
  });

  it('propagates an AbortSignal', async () => {
    const mockRes = new Response(new ReadableStream(), { status: 200 });
    vi.mocked(client.postStream).mockResolvedValue(mockRes as any);
    const signal = new AbortController().signal;

    await openChatPackStream({ packId: 'koala', conversationId: 'c1', message: 'hi' }, signal);

    expect(client.postStream).toHaveBeenCalledWith(
      '/chat-pack/koala',
      { conversationId: 'c1', message: 'hi' },
      signal,
    );
  });
});

describe('chat-pack conversation & proposal helpers', () => {
  it('calls conversation endpoints correctly', async () => {
    const { listChatConversations, getChatConversation, createChatConversation, deleteChatConversation } = await import('../api/chat-pack.js');
    
    vi.mocked(client.api.get).mockResolvedValueOnce({ data: [{ id: 'conv-1' }] });
    const list = await listChatConversations();
    expect(client.api.get).toHaveBeenCalledWith('/chat-pack/conversations');
    expect(list).toEqual([{ id: 'conv-1' }]);

    vi.mocked(client.api.get).mockResolvedValueOnce({ data: { id: 'conv-1', title: 'Hello' } });
    const conv = await getChatConversation('conv-1');
    expect(client.api.get).toHaveBeenCalledWith('/chat-pack/conversations/conv-1');
    expect(conv).toEqual({ id: 'conv-1', title: 'Hello' });

    vi.mocked(client.api.post).mockResolvedValueOnce({ data: { id: 'conv-2' } });
    const created = await createChatConversation('New Title');
    expect(client.api.post).toHaveBeenCalledWith('/chat-pack/conversations', { title: 'New Title' });
    expect(created).toEqual({ id: 'conv-2' });

    vi.mocked(client.api.delete).mockResolvedValueOnce({ data: { success: true } });
    await deleteChatConversation('conv-2');
    expect(client.api.delete).toHaveBeenCalledWith('/chat-pack/conversations/conv-2');
  });

  it('calls proposal acceptance endpoints', async () => {
    const { acceptTreeProposal, acceptSpecProposal } = await import('../api/chat-pack.js');

    vi.mocked(client.api.post).mockResolvedValueOnce({ data: { tree: { id: 'tree-1' } } });
    const treeRes = await acceptTreeProposal('conv-1', 'prop-1');
    expect(client.api.post).toHaveBeenCalledWith('/chat-pack/conversations/conv-1/trees/prop-1/accept', {});
    expect(treeRes).toEqual({ tree: { id: 'tree-1' } });

    vi.mocked(client.api.post).mockResolvedValueOnce({ data: { id: 'spec-1' } });
    const specRes = await acceptSpecProposal('conv-1', 'spec-1');
    expect(client.api.post).toHaveBeenCalledWith('/chat-pack/conversations/conv-1/specs/spec-1/accept', {});
    expect(specRes).toEqual({ id: 'spec-1' });
  });
});