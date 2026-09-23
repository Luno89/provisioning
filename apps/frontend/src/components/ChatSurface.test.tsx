import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ChatSurface from '../components/ChatSurface.js';
import * as chatPackApi from '../api/chat-pack.js';
import * as client from '../api/client.js';
import * as engineApi from '../api/engine.js';
import { useLiveTurnsStore, conversationTurnKey } from '../stores/live-turns.js';
import { ENGINE_EVENT_CHANNEL, type EngineEvent } from '../api/engine.js';

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
  patchChatConversation: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test Conversation', messages: [] }),
}));

vi.mock('../api/models', async (orig) => ({
  ...(await orig<typeof import('../api/models.js')>()),
  listModels: vi.fn().mockResolvedValue([
    { id: 'm1', name: 'First', source: 'endpoint', model: 'm1-model', sourceLabel: 'Primary' },
    { id: 'm2', name: 'Second', source: 'endpoint', model: 'm2-model', sourceLabel: 'Secondary' },
  ] as never),
  useDefaultModel: () => ({ data: null }),
}));

vi.mock('../api/agents', async (orig) => ({
  ...(await orig<typeof import('../api/agents.js')>()),
  listAgents: vi.fn().mockResolvedValue([
    {
      slug: 'koala', ownerId: undefined, name: 'Koala', description: 'The default conversationalist.',
      version: '1', prompt: '', guidance: '', returns: '', failures: [], procedure: 'procedure: tool-rounds',
      tools: [], agents: [], environment: { terminal: false, filesystem: false, egress: false, git: false, workspace: false, languages: [] },
      model: undefined, mine: false,
    },
    {
      slug: 'heron', ownerId: 'u-1', name: 'Heron', description: 'Does careful ground-truth writes.',
      version: '2', prompt: '', guidance: 'Always check before writing.', returns: '', failures: [], procedure: 'procedure: tool-rounds',
      tools: ['read', 'write'], agents: [], environment: { terminal: true, filesystem: true, egress: false, git: true, workspace: true, languages: ['bash'] },
      model: { endpointId: 'm2' }, mine: true,
    },
  ] as never),
}));

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof client>()),
  postStream: vi.fn(),
}));

vi.mock('../api/grove', async (orig) => ({
  ...(await orig<typeof import('../api/grove.js')>()),
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

/**
 * The chat turns ride an engine run: startRun POSTs /engine/runs, and the run's engine events
 * arrive on the ENGINE_EVENT_CHANNEL via the socket bridge. The mock below keeps a module-level
 * table of the registered handlers so a test can deliver a scripted event stream to the surface
 * exactly as the socket bridge would.
 */
const { socketHandlers } = vi.hoisted(() => ({
  socketHandlers: new Map<string, (event: unknown) => void>(),
}));

vi.mock('../stores/socket.js', () => ({
  useSocketEvent: (channel: string, handler: (event: unknown) => void) => {
    socketHandlers.set(channel, handler);
  },
  getSocket: () => ({ emit: () => undefined }),
}));

vi.mock('../api/engine.js', async (orig) => ({
  ...(await orig<typeof import('../api/engine.js')>()),
  startRun: vi.fn(),
  cancelRun: vi.fn().mockResolvedValue({ ok: true }),
  approveRunCall: vi.fn().mockResolvedValue({ ok: true }),
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

const RUN_ID = 'run-1';
const AT = '2025-01-01T00:00:00.000Z';

type EventSeed = { type: string } & Record<string, unknown>;

/** Deliver a scripted engine-event stream to the registered socket handler. */
function emit(...seeds: EventSeed[]) {
  for (const seed of seeds) {
    socketHandlers.get(ENGINE_EVENT_CHANNEL)?.({ runId: RUN_ID, at: AT, ...(seed as object) } as EngineEvent);
  }
}

/** Wait until sendConversationTurn has posted the /engine/runs start, so the event stream can land. */
async function waitForRunStarted() {
  await waitFor(() => expect(engineApi.startRun).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  queryClient.clear();
  useLiveTurnsStore.setState({ turns: {} });
  vi.mocked(engineApi.startRun).mockResolvedValue({ runId: RUN_ID, agentSlug: 'koala', loopId: 'koala-chat' } as never);
  vi.mocked(engineApi.cancelRun).mockResolvedValue({ ok: true } as never);
  vi.mocked(engineApi.approveRunCall).mockResolvedValue({ ok: true } as never);
  vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
    id,
    title: 'Test Conversation',
    messages: [],
  }) as never);
});

describe('ChatSurface — unified persona-pack chat surface', () => {
  it('renders the input and starts an engine run on the koala agent', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    expect(engineApi.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'koala',
        message: 'hi',
        conversationId: 'c1',
        inputs: { conversationId: 'c1' },
      }),
    );

    emit(
      { type: 'content', delta: 'Hello' },
      { type: 'content', delta: ' world' },
      { type: 'run.finished', outcome: 'ok' },
    );
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());
  });

  it('keeps a streaming run alive across an unmount and remount (navigating away and back)', async () => {
    const first = renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit({ type: 'content', delta: 'Hello' });
    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());

    // The in-flight run and its reply accumulation live in module scope (live-turns store and
    // the liveRuns table), so a real unmount — a view swap in App.tsx — drops the listener but
    // not the turn. The remaining delta lands while nobody is subscribed, and on remount the
    // surface picks up the still-streaming turn right where it left off.
    first.unmount();
    emit({ type: 'content', delta: ' world' });

    renderWithProviders(<ChatSurface conversationId="c1" />);
    await waitFor(() => expect(screen.getByText('Hello world')).toBeInTheDocument());

    emit({ type: 'run.finished', outcome: 'ok' });
  });

  it('does not lose or duplicate a turn when the sidebar switches conversations while it is still streaming', async () => {
    const { rerender } = renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    // Same component instance, as clicking a different thread in the sidebar mid-turn — the
    // in-flight run (still keyed by conversation c1) keeps painting in the background.
    rerender(<QueryClientProvider client={queryClient}><ChatSurface conversationId="c2" /></QueryClientProvider>);
    rerender(<QueryClientProvider client={queryClient}><ChatSurface conversationId="c1" /></QueryClientProvider>);

    await waitForRunStarted();
    emit({ type: 'content', delta: 'Hello' }, { type: 'run.finished', outcome: 'ok' });

    await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument());
    expect(screen.getAllByText('hi')).toHaveLength(1);
    expect(screen.getAllByText('Hello')).toHaveLength(1);
  });

  it('keeps the partial reply, thinking, and tool call visible after Stop is clicked mid-stream', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'thinking', delta: 'pondering' },
      { type: 'content', delta: 'Partial answer' },
      { type: 'tool.called', nodeId: 'c.cwd.run_command', callId: 'tc1', name: 'run_command', args: '{"command":"ls"}' },
    );
    await waitFor(() => expect(screen.getByText('Partial answer')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/stop gen/i));

    // Stop asks the engine to cancel the run and settles the bubble immediately — the partial
    // must not be lost, and a late run.finished on its tail must not double-save it.
    expect(engineApi.cancelRun).toHaveBeenCalledWith(RUN_ID);
    expect(screen.getByText('run_command')).toBeInTheDocument();
    expect(screen.getByText(/interrupted/i)).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();

    // A run.finished event coming afterwards must not double-append the partial.
    emit({ type: 'run.finished', outcome: 'interrupted' });
    await waitFor(() => expect(screen.getAllByText('Partial answer')).toHaveLength(1));
  });

  it('keeps the partial reply when the run ends failed', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit({ type: 'content', delta: 'Partial before drop' });
    await waitFor(() => expect(screen.getByText('Partial before drop')).toBeInTheDocument());

    emit({ type: 'run.finished', outcome: 'failed', reason: 'network reset' });

    await screen.findByText(/Turn stopped: network reset/);
    expect(screen.getByText(/Stopped early: network reset/)).toBeInTheDocument();
  });

  it('renders a thinking pane when thinking events arrive', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'thinking', delta: 'let me think' },
      { type: 'content', delta: 'Answer' },
      { type: 'run.finished', outcome: 'ok' },
    );

    await waitFor(() => expect(screen.getByText('let me think')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Answer')).toBeInTheDocument());
  });

  it('shows a tool pill that flips to done when tool.result arrives', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    const inp = screen.getByPlaceholderText(/message/i);
    fireEvent.change(inp, { target: { value: 'logs' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'tool.called', callId: 'tc1', name: 'get_logs', args: '{"pod":"p"}' },
      { type: 'tool.result', callId: 'tc1', ok: true, digest: 'log lines...' },
      { type: 'content', delta: 'Done' },
      { type: 'run.finished', outcome: 'ok' },
    );

    await waitFor(() => expect(screen.getByText('get_logs')).toBeInTheDocument());
    fireEvent.click(screen.getByText('get_logs'));
    await waitFor(() => expect(screen.getByText('log lines...')).toBeInTheDocument());
  });

  it('accumulates enabled services (branch scope still rides the legacy frames)', async () => {
    const mockRes = {
      body: makeSseStream([
        '{"type":"enabled","payload":["github-mcp"]}',
        '{"type":"content","delta":"Ok"}',
      ]),
      status: 200,
      ok: true,
    };
    vi.mocked(client.postStream).mockResolvedValue(mockRes as never);

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
      />,
    );

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
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

    expect(await screen.findByText((c) => c.includes('github-mcp'))).toBeInTheDocument();
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
    renderWithProviders(<ChatSurface conversationId="c1" />);

    // The conversation fetches first — otherwise the hero flashes and gets replaced.
    expect(await screen.findByText('Propose Project Tree')).toBeInTheDocument();
    expect(screen.getByText('Inspect Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Propose App Spec')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Propose Project Tree'));

    await waitForRunStarted();
    expect(engineApi.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'koala',
        conversationId: 'c1',
        message: expect.stringContaining('Propose a new project architecture'),
        inputs: { conversationId: 'c1' },
      }),
    );

    // Drain the run so no half-finished turn leaks into the next test's surface.
    emit({ type: 'run.finished', outcome: 'ok' });
    await waitFor(() =>
      expect(useLiveTurnsStore.getState().turns[conversationTurnKey('c1')]?.status).toBe('done'),
    );
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
   * Regression: the "Add to catalogue" button on suggested specs was calling the accept endpoint (which was
   * succeeding server-side) while not rendering the state after the persisted accept, so it looked like
   * clicking did nothing. What this asserts: that a proposedSpecs entry renders in the proposal sidebar,
   * that accept calls the real endpoint, and that acceptedAt makes it drop out of the pending list.
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
    }) as never);
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
   * Regression: acceptTreeMutation was reading `res.treeId`, but the backend response shape is
   * `{ tree: { id, ... }, branch, project, planning }` — the top-level `treeId` does not exist,
   * so onOpenTree never fired, and the accept of a project suggestion silently failed to redirect anywhere.
   */
  it('redirects to the accepted tree via onOpenTree, reading the id from res.tree.id', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValueOnce({
      id: 'c1',
      title: 'Test Conversation',
      messages: [{ role: 'user', content: 'plan a new project' }],
      proposedTrees: [{
        id: 'prop-1', name: 'Odoo Rollout', type: 'default', goal: 'Roll out Odoo', proposedAt: '2026-09-06T12:00:00Z',
      }],
    } as never);
    vi.mocked(chatPackApi.acceptTreeProposal).mockResolvedValue({
      tree: { id: 'tree-1', name: 'Odoo Rollout' },
      branch: { id: 'branch-1' },
      project: { id: 'project-1' },
      planning: false,
    } as never);
    const onOpenTree = vi.fn();

    renderWithProviders(<ChatSurface conversationId="c1" onOpenTree={onOpenTree} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /toggle proposals/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /toggle proposals/i }));

    await waitFor(() => expect(screen.getByText('Accept to Grove')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Accept to Grove'));

    await waitFor(() => expect(chatPackApi.acceptTreeProposal).toHaveBeenCalledWith('c1', 'prop-1'));
    await waitFor(() => expect(onOpenTree).toHaveBeenCalledWith('tree-1'));
  });

  it('raises the proposals badge when the run saved a proposal, and the pending one appears via the panel', async () => {
    let runFinished = false;
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
      id,
      title: 'Test Conversation',
      messages: [],
      proposedTrees: runFinished
        ? [{ id: 'prop-2', name: 'Odoo Rollout', type: 'default', goal: 'Roll out Odoo', proposedAt: AT }]
        : [],
    }) as never);

    renderWithProviders(<ChatSurface conversationId="c1" />);
    expect(await screen.findByText('Propose Project Tree')).toBeInTheDocument();

    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'plan something' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    // The engine saves the conversation (proposal and all) before it announces the run is
    // finished — so the flag that stands in for the persisted proposal flips before the final
    // events land.
    runFinished = true;
    emit({ type: 'content', delta: 'Here is a plan.' }, { type: 'run.finished', outcome: 'ok' });

    // The run finished and the engine persisted the proposal: the surface refreshes the
    // conversation and displays a pending-proposal badge, and the one surfaces via the panel.
    await waitFor(() => expect(screen.getByRole('button', { name: /toggle proposals/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /toggle proposals/i }));
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
    } as never);

    renderWithProviders(<ChatSurface conversationId="c-elevated" />);

    await waitFor(() => expect(screen.getByText(/ELEVATED \(cluster-admin\)/i)).toBeInTheDocument());
  });

  it('shows an approval card when the run asks about a tool call, and settles it on decision', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    const input = screen.getByPlaceholderText(/message/i);
    fireEvent.change(input, { target: { value: 'run it' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'tool.called', callId: 'tc1', name: 'run_command', args: '{"command":"docker compose up"}' },
      { type: 'notice', level: 'warn', nodeId: 'turn.run_command', message: 'Koala wants to run run_command on this run: {"command":"docker compose up"}' },
    );

    const allowText = 'Koala wants to run run_command on this run: {"command":"docker compose up"}';
    await waitFor(() => expect(screen.getByText(/^Allow$/)).toBeInTheDocument());
    expect(screen.getByText(allowText)).toBeInTheDocument();
    expect(screen.getByText('run_command')).toBeInTheDocument();

    fireEvent.click(screen.getByText(/^Allow$/));
    await waitFor(() =>
      expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'tc1', allowed: true }),
    );
    await waitFor(() => expect(screen.queryByText(/^Allow$/)).not.toBeInTheDocument());

    emit(
      { type: 'tool.result', callId: 'tc1', ok: true, digest: 'compose up done' },
      { type: 'content', delta: 'All up' },
      { type: 'run.finished', outcome: 'ok' },
    );
    await waitFor(() => expect(screen.getByText('All up')).toBeInTheDocument());
  });

  it('runs the turn on the conversation\u2019s own agent, with its pinned model', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
      id,
      title: 'Test Conversation',
      messages: [],
      modelId: 'm1',
      agentSlug: 'heron',
    }) as never);

    renderWithProviders(<ChatSurface conversationId="c1" />);
    // The stored doc's pinned model only reaches the pick state once the conversation has
    // loaded — wait for that before sending, so the launch carries the doc's picks.
    await screen.findByRole('button', { name: /m1-model/ });
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    expect(engineApi.startRun).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'heron',
      message: 'hello',
      conversationId: 'c1',
      modelId: 'm1',
    }));
    // The picks already match the stored doc, so no re-patch goes out.
    expect(chatPackApi.patchChatConversation).not.toHaveBeenCalled();
  });

  it('patches the conversation when a different model is picked in the drawer', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
      id,
      title: 'Test Conversation',
      messages: [],
      modelId: 'm1',
    }) as never);

    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hello' } });

    const modelButton = await screen.findByRole('button', { name: /m1-model/ });
    fireEvent.click(modelButton);
    // Filter first: it expands every group/vendor, so the target row is always visible.
    fireEvent.change(screen.getByRole('textbox', { name: /filter models/i }), { target: { value: 'm2' } });
    fireEvent.click(await screen.findByRole('button', { name: /m2-model/ }));

    await waitFor(() =>
      expect(chatPackApi.patchChatConversation)
        .toHaveBeenCalledWith('c1', { modelId: 'm2', agentSlug: 'koala' }),
    );
  });

  it('persists the pick to the conversation when an agent is chosen in the drawer', async () => {
    const { within } = await import('@testing-library/react');
    const chipTitle = 'Pick who answers in this conversation, and see its directives and tools';

    renderWithProviders(<ChatSurface conversationId="c1" />);
    // The composer remounts once the conversation finishes loading, so re-query the chip each
    // time instead of holding a node reference across that transition.
    await waitFor(() => expect(screen.getByTitle(chipTitle)).toHaveTextContent('Koala'));
    fireEvent.click(screen.getByTitle(chipTitle));

    const drawer = screen.getByText('Agent & Capabilities').closest('.fixed') as HTMLElement;
    fireEvent.click(within(drawer).getByRole('button', { name: /Heron/ }));
    // Right pane shows the drafted agent's grants before anything is committed.
    expect(within(drawer).getByText('read')).toBeInTheDocument();
    fireEvent.click(await within(drawer).findByRole('button', { name: /use this agent/i }));

    await waitFor(() =>
      expect(chatPackApi.patchChatConversation)
        .toHaveBeenCalledWith('c1', expect.objectContaining({ agentSlug: 'heron' })),
    );
    await waitFor(() => expect(screen.getByTitle(chipTitle)).toHaveTextContent('Heron'));
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

    const personaBtn = screen.getByTitle('Pick who answers in this conversation, and see its directives and tools');
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

    const personaBtn = screen.getByTitle('Pick who answers in this conversation, and see its directives and tools');
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
    vi.mocked(client.postStream).mockResolvedValue(mockRes as never);

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