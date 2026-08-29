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

/**
 * The pack catalogue is fetched now, not hardcoded — see `api/packs.ts` for why. A surface with no
 * catalogue renders "Loading…" rather than guessing, so a test that asserts on a pack's label has
 * to supply one.
 */
vi.mock('../api/packs', async (orig) => ({
  ...(await orig<typeof import('../api/packs')>()),
  listPacks: vi.fn(async () => ([{
    id: 'pack-koala', slug: 'koala', name: 'Koala', description: 'General Builder',
    personaId: 'p-koala', toolset: 'assistant' as const,
    tools: [], permitted: ['read', 'write', 'propose'] as const, overrides: {},
  }])),
}));

vi.mock('../api/chat-pack', async (orig) => ({
  ...(await orig<typeof chatPackApi>()),
  openChatPackStream: vi.fn(),
  listChatConversations: vi.fn().mockResolvedValue([]),
  getChatConversation: vi.fn().mockImplementation(async (id: string) => ({
    id,
    title: 'Test Conversation',
    messages: [],
  })),
  acceptEscalationProposal: vi.fn().mockResolvedValue({ ok: true }),
  denyEscalationProposal: vi.fn().mockResolvedValue({ ok: true }),
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

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
});

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

    expect(chatPackApi.openChatPackStream).toHaveBeenCalledWith(
      expect.objectContaining({ packId: 'koala', conversationId: 'c1', message: 'hi' }),
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
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
    fireEvent.click(screen.getByText('get_logs'));
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

  it('renders initial messages and handles markdown formatting', () => {
    renderWithProviders(
      <ChatSurface
        packId="koala"
        initialMessages={[
          { role: 'user', content: 'hello from user' },
          { role: 'assistant', content: '**Bold reply** and `code`' },
        ]}
      />
    );

    expect(screen.getByText('hello from user')).toBeInTheDocument();
    expect(screen.getByText('Bold reply')).toBeInTheDocument();
    expect(screen.getByText('code')).toBeInTheDocument();
  });

  it('renders starter prompt chips in empty state and sends when clicked', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"content","delta":"Generated project spec"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface packId="koala" conversationId="c1" />);

    expect(screen.getByText('Propose Project Tree')).toBeInTheDocument();
    expect(screen.getByText('Inspect Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Propose App Spec')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Propose Project Tree'));

    expect(chatPackApi.openChatPackStream).toHaveBeenCalledWith(
      expect.objectContaining({
        packId: 'koala',
        message: expect.stringContaining('Propose a new project architecture'),
      }),
      expect.any(AbortSignal),
    );
  });

  it('renders avatars for user and assistant messages in conversation stream', async () => {
    renderWithProviders(
      <ChatSurface
        packId="koala"
        initialMessages={[
          { role: 'user', content: 'What is the cluster status?' },
          { role: 'assistant', content: 'All 3 nodes are ready.' },
        ]}
      />
    );

    expect(screen.getByText('You')).toBeInTheDocument();
    // The pack's label arrives with the catalogue rather than from a hardcoded array, so it appears
    // on the next tick. The surface shows no name at all until it knows one — see `activePack`.
    await waitFor(() => expect(screen.getAllByText('KOALA').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText('What is the cluster status?')).toBeInTheDocument();
    expect(screen.getByText('All 3 nodes are ready.')).toBeInTheDocument();
  });

  it('renders EscalationProposalCard and handles approval', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValueOnce({
      id: 'c1',
      title: 'Test Conversation',
      messages: [{ role: 'user', content: 'diagnose prometheus' }],
      proposedEscalations: [{
        id: 'esc-1',
        reason: 'Need access to Prometheus',
        scope: 'cluster-admin',
        namespaces: ['monitoring'],
        status: 'pending',
        proposedAt: '2026-08-26T12:00:00Z',
      }],
    });

    renderWithProviders(<ChatSurface packId="koala" conversationId="c1" />);

    await waitFor(() => expect(screen.getByText('Privilege Escalation Requested')).toBeInTheDocument());
    expect(screen.getByText('Need access to Prometheus')).toBeInTheDocument();
    expect(screen.getByText('cluster-admin')).toBeInTheDocument();
    expect(screen.getByText('monitoring')).toBeInTheDocument();

    const approveBtn = screen.getByRole('button', { name: /approve escalation/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(chatPackApi.acceptEscalationProposal).toHaveBeenCalledWith('c1', 'esc-1'));
  });

  it('displays ELEVATED badge in header bar when conversation is escalated', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValueOnce({
      id: 'c-elevated',
      title: 'Admin Ops',
      isEscalated: true,
      escalatedScope: 'cluster-admin',
      messages: [{ role: 'user', content: 'Cluster check' }],
    });

    renderWithProviders(<ChatSurface packId="koala" conversationId="c-elevated" />);

    await waitFor(() => expect(screen.getByText(/ELEVATED \(cluster-admin\)/i)).toBeInTheDocument());
  });
});