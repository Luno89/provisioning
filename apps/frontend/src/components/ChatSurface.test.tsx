import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ChatSurface from '../components/ChatSurface.js';
import * as chatPackApi from '../api/chat-pack.js';
import * as client from '../api/client.js';

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
  acceptSpecProposal: vi.fn().mockResolvedValue({ id: 'mongo' }),
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

    renderWithProviders(<ChatSurface conversationId="c1" />);

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    expect(chatPackApi.openChatPackStream).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', message: 'hi' }),
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
  });

  it('keeps a streaming reply alive across an unmount and remount (navigating away and back)', async () => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller; },
    });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(new Response(stream, { status: 200 }) as any);

    const { unmount } = renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    controllerRef.enqueue(encoder.encode('data: {"type":"content","delta":"Hello"}\n\n'));
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    // Navigate away: this is a real unmount, same as a view swap in App.tsx. Nothing aborts the
    // fetch, so the SSE loop reading `stream` keeps running as an orphaned promise — exactly what
    // happens in the app when the user leaves the chat view mid-stream.
    unmount();

    controllerRef.enqueue(encoder.encode('data: {"type":"content","delta":" world"}\n\n'));
    controllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
    controllerRef.close();

    // Navigate back: a fresh ChatSurface instance for the same conversation id should pick up
    // right where the background stream left off, not start blank.
    renderWithProviders(<ChatSurface conversationId="c1" />);
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
  });

  it('renders a thinking pane when thinking frames arrive', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"thinking","delta":"let me think"}',
      '{"type":"content","delta":"Answer"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface conversationId="c1" />);
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

    renderWithProviders(<ChatSurface conversationId="c1" />);
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

    renderWithProviders(<ChatSurface conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText((c) => c.includes('github-mcp'))).toBeInTheDocument());
  });

  it('renders initial messages and handles markdown formatting', () => {
    renderWithProviders(
      <ChatSurface
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

  it('shows the koala while a conversation is being fetched, not an empty thread', () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/Fetching this conversation/i);
  });

  it('keeps the composer usable while the conversation loads', () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    expect(screen.getByPlaceholderText(/message/i)).toBeInTheDocument();
  });

  it('renders starter prompt chips in empty state and sends when clicked', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"content","delta":"Generated project spec"}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface conversationId="c1" />);

    // The conversation is fetched first — the hero would otherwise flash and be replaced.
    expect(await screen.findByText('Propose Project Tree')).toBeInTheDocument();
    expect(screen.getByText('Inspect Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Propose App Spec')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Propose Project Tree'));

    await waitFor(() => expect(chatPackApi.openChatPackStream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('Propose a new project architecture'),
      }),
      expect.any(AbortSignal),
    ));
  });

  it('renders avatars for user and assistant messages in conversation stream', async () => {
    renderWithProviders(
      <ChatSurface
        initialMessages={[
          { role: 'user', content: 'What is the cluster status?' },
          { role: 'assistant', content: 'All 3 nodes are ready.' },
        ]}
      />
    );

    expect(screen.getByText('You')).toBeInTheDocument();
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

    renderWithProviders(<ChatSurface conversationId="c1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /toggle proposals/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /toggle proposals/i }));

    await waitFor(() => expect(screen.getByText('Privilege Escalation Requested')).toBeInTheDocument());
    expect(screen.getByText('Need access to Prometheus')).toBeInTheDocument();
    expect(screen.getByText('cluster-admin')).toBeInTheDocument();
    expect(screen.getByText('monitoring')).toBeInTheDocument();

    const approveBtn = screen.getByRole('button', { name: /approve escalation/i });
    fireEvent.click(approveBtn);

    await waitFor(() => expect(chatPackApi.acceptEscalationProposal).toHaveBeenCalledWith('c1', 'esc-1'));
  });

  /**
   * Regression: a proposed spec's "Add to the catalogue" button called the accept endpoint (which
   * succeeded server-side) but nothing rendered the persisted, post-accept state, so it looked like
   * clicking did nothing. This asserts a proposedSpecs entry renders in the proposals sidebar, that
   * accepting calls the real endpoint, and that acceptedAt drops it out of the pending list.
   */
  it('renders a proposed spec in the sidebar, accepts it, and it drops out of the pending list', async () => {
    const spec = {
      id: 'mongo', image: 'mongo:7', ports: [{ name: 'mongodb', port: 27017 }],
    };
    let accepted = false;
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async () => ({
      id: 'c1',
      title: 'Test Conversation',
      messages: [{ role: 'user', content: 'add mongo' }],
      proposedSpecs: [{
        id: 'mongo', spec, proposedAt: '2026-09-03T12:00:00Z',
        ...(accepted ? { acceptedAt: '2026-09-03T12:00:05Z' } : {}),
      }],
    }));
    vi.mocked(chatPackApi.acceptSpecProposal).mockImplementation(async () => {
      accepted = true;
      return { id: 'mongo' };
    });

    renderWithProviders(<ChatSurface conversationId="c1" />);

    await waitFor(() => expect(screen.getByRole('button', { name: /toggle proposals/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /toggle proposals/i }));

    await waitFor(() => expect(screen.getByText('Add to the catalogue')).toBeInTheDocument());
    expect(screen.getByText('mongo')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add to the catalogue'));
    await waitFor(() => expect(chatPackApi.acceptSpecProposal).toHaveBeenCalledWith('c1', 'mongo'));
    await waitFor(() => expect(screen.getByText('Nothing pending')).toBeInTheDocument());
    expect(screen.queryByText('Add to the catalogue')).not.toBeInTheDocument();
  });

  it('displays ELEVATED badge in header bar when conversation is escalated', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValueOnce({
      id: 'c-elevated',
      title: 'Admin Ops',
      isEscalated: true,
      escalatedScope: 'cluster-admin',
      messages: [{ role: 'user', content: 'Cluster check' }],
    });

    renderWithProviders(<ChatSurface conversationId="c-elevated" />);

    await waitFor(() => expect(screen.getByText(/ELEVATED \(cluster-admin\)/i)).toBeInTheDocument());
  });
});