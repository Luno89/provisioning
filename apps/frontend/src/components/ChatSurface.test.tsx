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
  acceptTreeProposal: vi.fn(),
}));

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof client>()),
  postStream: vi.fn(),
}));

vi.mock('../api/grove', async (orig) => ({
  ...(await orig<any>()),
  updateTreeType: vi.fn().mockResolvedValue({ id: 'type-1' }),
  listTrees: vi.fn().mockResolvedValue([{ id: 't-1', name: 'Tree 1', type: 'type-1' }]),
  listTreeTypes: vi.fn().mockResolvedValue([{
    id: 'type-1',
    label: 'Type 1',
    summary: 'Type summary',
    doneMeans: 'done',
    language: 'node',
    produces: 'service',
    files: [],
    packs: { planner: 'planner' },
  }]),
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

  it('does not lose or duplicate a turn when the sidebar switches conversations while it is still streaming', async () => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller; },
    });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(new Response(stream, { status: 200 }) as any);

    const { rerender } = renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Same component instance, same as clicking a different thread in the sidebar mid-turn — the
    // in-flight send (still tied to c1's conversationTurnKey) keeps running in the background.
    rerender(<QueryClientProvider client={queryClient}><ChatSurface conversationId="c2" /></QueryClientProvider>);
    rerender(<QueryClientProvider client={queryClient}><ChatSurface conversationId="c1" /></QueryClientProvider>);

    controllerRef.enqueue(encoder.encode('data: {"type":"content","delta":"Hello"}\n\n'));
    controllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
    controllerRef.close();

    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.getAllByText('hi')).toHaveLength(1);
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('keeps the partial reply, thinking, and tool call visible after Stop is clicked mid-stream', async () => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller; },
    });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(new Response(stream, { status: 200 }) as any);

    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    controllerRef.enqueue(encoder.encode('data: {"type":"thinking","delta":"pondering"}\n\n'));
    controllerRef.enqueue(encoder.encode('data: {"type":"content","delta":"Partial answer"}\n\n'));
    controllerRef.enqueue(encoder.encode('data: {"type":"toolAnnounce","payload":{"id":"t1","name":"get_logs","args":"{}"}}\n\n'));
    await waitFor(() => expect(screen.getByText('Partial answer')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/stop generation/i));

    // The live bubble unmounts the instant Stop is clicked (status flips away from streaming) —
    // the content must already be in the persisted message list by then, not lost with it.
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    expect(screen.getByText('get_logs')).toBeInTheDocument();
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();

    controllerRef.close();
  });

  it('keeps the partial reply when the stream fails for a reason other than Stop', async () => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller; },
    });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(new Response(stream, { status: 200 }) as any);

    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    controllerRef.enqueue(encoder.encode('data: {"type":"content","delta":"Partial before drop"}\n\n'));
    await waitFor(() => expect(screen.getByText('Partial before drop')).toBeInTheDocument());

    // Simulate a dropped connection: the reader rejects with a non-abort error, never emitting [DONE].
    controllerRef.error(new Error('network reset'));

    await waitFor(() => expect(screen.getByText(/turn failed/i)).toBeInTheDocument());
    expect(screen.getByText('Partial before drop')).toBeInTheDocument();
    expect(screen.getByText(/stopped early/i)).toBeInTheDocument();
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

  /**
   * Regression: acceptTreeMutation used to read `res.treeId`, but the backend response shape is
   * `{ tree: { id, ... }, branch, project, planning }` — there is no top-level `treeId`, so
   * onOpenTree never fired and accepting a project proposal silently failed to redirect anywhere.
   */
  it('redirects to the accepted tree via onOpenTree, reading the id from res.tree.id', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValueOnce({
      id: 'c1',
      title: 'Test Conversation',
      messages: [{ role: 'user', content: 'plan a new project' }],
      proposedTrees: [{
        id: 'prop-1', name: 'Odoo Rollout', type: 'default', goal: 'Roll out Odoo', proposedAt: '2026-09-06T12:00:00Z',
      }],
    });
    vi.mocked(chatPackApi.acceptTreeProposal).mockResolvedValue({
      tree: { id: 'tree-1', name: 'Odoo Rollout' },
      branch: { id: 'branch-1' },
      project: { id: 'project-1' },
      planning: false,
    });
    const onOpenTree = vi.fn();

    renderWithProviders(<ChatSurface conversationId="c1" onOpenTree={onOpenTree} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /toggle proposals/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /toggle proposals/i }));

    await waitFor(() => expect(screen.getByText('Accept to Grove')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Accept to Grove'));

    await waitFor(() => expect(chatPackApi.acceptTreeProposal).toHaveBeenCalledWith('c1', 'prop-1'));
    await waitFor(() => expect(onOpenTree).toHaveBeenCalledWith('tree-1'));
  });

  it('opens the Proposals panel on its own when Koala proposes a project live, without the user clicking Toggle proposals', async () => {
    const mockRes = new Response(makeSseStream([
      '{"type":"content","delta":"Here is a plan."}',
      '{"type":"proposedTree","payload":{"id":"prop-2","name":"Odoo Rollout","type":"default"}}',
    ]), { status: 200 });
    vi.mocked(chatPackApi.openChatPackStream).mockResolvedValue(mockRes as any);

    renderWithProviders(<ChatSurface conversationId="c1" />);

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'plan something' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(screen.getByText('Odoo Rollout')).toBeInTheDocument());
    expect(screen.getByText('Accept to Grove')).toBeInTheDocument();
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

  it('opens PersonaConfigDrawer when persona button is clicked on branch chat', async () => {
    renderWithProviders(
      <ChatSurface
        scope={{
          kind: 'branch',
          branchId: 'b-1',
          treeId: 't-1',
          mode: 'chat',
          messages: [],
          onMessagesChange: vi.fn(),
        }}
      />
    );

    const personaBtn = screen.getByTitle('Pick the pack, and edit its directives and tools');
    expect(personaBtn).toBeInTheDocument();
    fireEvent.click(personaBtn);

    await waitFor(() => {
      expect(screen.getByText('Persona & Capabilities')).toBeInTheDocument();
    });
  });

  it('sets the persona-pack on the branch tree type when a pack is selected in PersonaConfigDrawer', async () => {
    const groveApi = await import('../api/grove.js');
    renderWithProviders(
      <ChatSurface
        scope={{
          kind: 'branch',
          branchId: 'b-1',
          treeId: 't-1',
          mode: 'chat',
          messages: [],
          onMessagesChange: vi.fn(),
        }}
      />
    );

    const personaBtn = screen.getByTitle('Pick the pack, and edit its directives and tools');
    fireEvent.click(personaBtn);

    await waitFor(() => {
      expect(screen.getByText('Persona & Capabilities')).toBeInTheDocument();
    });

    // Click the pack in the packs list
    const packBtn = await screen.findByRole('button', { name: /Koala/i });
    fireEvent.click(packBtn);

    await waitFor(() => {
      expect(groveApi.updateTreeType).toHaveBeenCalledWith(
        'type-1',
        expect.objectContaining({
          id: 'type-1',
          packs: expect.objectContaining({ planner: 'koala' }),
        })
      );
    });
  });

  it('renders thinking disclosure and tool calls in branch chat during SSE stream', async () => {
    const mockRes = {
      body: makeSseStream([
        '{"type":"thinking","delta":"Analyzing repo structure..."}',
        '{"type":"toolAnnounce","payload":{"id":"tool-1","name":"read_file","args":"{\\"path\\":\\"package.json\\"}"}}',
        '{"type":"toolResult","payload":{"id":"tool-1","ok":true,"digest":"read 45 lines"}}',
        '{"type":"content","delta":"The package is configured correctly."}',
      ]),
      status: 200,
      ok: true,
    };
    vi.mocked(client.postStream).mockResolvedValue(mockRes as any);

    let currentMessages: any[] = [];
    const onMessagesChange = vi.fn().mockImplementation((next) => {
      currentMessages = typeof next === 'function' ? next(currentMessages) : next;
    });

    const { rerender } = renderWithProviders(
      <ChatSurface
        scope={{
          kind: 'branch',
          branchId: 'b-1',
          treeId: 't-1',
          mode: 'chat',
          messages: currentMessages,
          onMessagesChange,
        }}
      />
    );

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'Inspect the code' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Re-render when onMessagesChange triggers
    await waitFor(() => expect(onMessagesChange).toHaveBeenCalled());

    rerender(
      <QueryClientProvider client={queryClient}>
        <ChatSurface
          scope={{
            kind: 'branch',
            branchId: 'b-1',
            treeId: 't-1',
            mode: 'chat',
            messages: currentMessages,
            onMessagesChange,
          }}
        />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('read_file')).toBeInTheDocument();
      expect(screen.getByText('completed')).toBeInTheDocument();
      expect(screen.getByText('Analyzing repo structure...')).toBeInTheDocument();
    });
  });

  it('renders thinking disclosure and tool calls for persisted branch messages', () => {
    renderWithProviders(
      <ChatSurface
        scope={{
          kind: 'branch',
          branchId: 'b-1',
          treeId: 't-1',
          mode: 'chat',
          messages: [
            { role: 'user', content: 'check tree' },
            {
              role: 'assistant',
              content: 'Everything looks healthy.',
              reasoning: 'Verified all dependencies and cluster health.',
              toolCalls: [
                { id: 't1', name: 'check_health', args: '{}', ok: true, digest: 'All ok' },
              ],
            },
          ],
          onMessagesChange: vi.fn(),
        }}
      />
    );

    expect(screen.getByText('check_health')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText(/Thought Process & Analysis/i)).toBeInTheDocument();
    expect(screen.getByText('Verified all dependencies and cluster health.')).toBeInTheDocument();
    expect(screen.getByText('Everything looks healthy.')).toBeInTheDocument();
  });
});