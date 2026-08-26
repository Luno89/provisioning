import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ChatSurface from '../components/ChatSurface.js';
import * as chatPackApi from '../api/chat-pack.js';
import * as client from '../api/client.js';

/**
 * RED: ChatSurface component with the unified wire.
 *
 * Renders a chat for a given persona pack, streams unified frames, and renders
 * - live assistant text (content frames)
 * - live thinking (thinking frames)
 * - tool pills (toolAnnounce → toolResult)
 * - enabled services banner
 *
 * Mocks at the api module boundary (chat-pack) and client boundary (postStream),
 * same pattern as KoalaChat.test.
 */

vi.mock('../api/chat-pack', async (orig) => ({
  ...(await orig<typeof chatPackApi>()),
  openChatPackStream: vi.fn(),
}));

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof client>()),
  postStream: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function renderWithProviders(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeSseStream(frames: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

beforeEach(() => vi.clearAllMocks());

describe('ChatSurface — unified persona-pack chat surface', () => {
  it('renders the input and sends the message to the pack route', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"content","delta":"Hello"}',
      '{"type":"content","delta":" world"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface packId="koala" conversationId="c1" />);

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
    expect(chatPackApi.openChatPackStream).toHaveBeenCalledWith(
      { packId: 'koala', conversationId: 'c1', message: 'hi' },
      expect.any(AbortSignal),
    );
  });

  it('renders a thinking pane when thinking frames arrive', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"thinking","delta":"let me think"}',
      '{"type":"content","delta":"Answer"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface packId="researcher" conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText('let me think')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Answer')).toBeInTheDocument());
  });

  it('shows a tool pill that flips to done when toolResult arrives', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"toolAnnounce","payload":{"id":"c1","name":"get_logs","args":"{\\"pod\\":\\"p\\"}"}}',
      '{"type":"toolResult","payload":{"id":"c1","ok":true,"digest":"log lines..."}}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface packId="koala" conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'logs' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText('get_logs')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('log lines...')).toBeInTheDocument());
  });

  it('accumulates enabled services', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"enabled","payload":["github-mcp"]}',
      '{"type":"content","delta":"Ok"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface packId="koala" conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText((c) => c.includes('github-mcp'))).toBeInTheDocument());
  });
});