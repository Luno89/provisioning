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