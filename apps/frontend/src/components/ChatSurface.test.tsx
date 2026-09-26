import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ChatSurface from '../components/ChatSurface.js';
import * as chatPackApi from '../api/chat-pack.js';
import * as engineApi from '../api/engine.js';
import { useLiveTurnsStore, conversationTurnKey } from '../stores/live-turns.js';
import { ENGINE_EVENT_CHANNEL, type EngineEvent } from '../api/engine.js';

vi.mock('../api/chat-pack', async (orig) => ({
  ...(await orig<typeof chatPackApi>()),
  listChatConversations: vi.fn().mockResolvedValue([]),
  getChatConversation: vi.fn().mockImplementation(async (id: string) => ({
    id,
    title: 'Test Conversation',
    messages: [],
  })),
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

  it('saves a new conversation\'s default picks once, not on every render while a reply streams', async () => {
    queryClient.clear();
    renderWithProviders(<ChatSurface conversationId="c-fresh" />);
    await waitFor(() => expect(chatPackApi.patchChatConversation).toHaveBeenCalledWith('c-fresh', expect.objectContaining({ agentSlug: 'koala' })));

    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitForRunStarted();
    emit({ type: 'content', delta: 'Hi' });
    emit({ type: 'content', delta: ' there' });
    await screen.findByText(/Hi there/);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(chatPackApi.patchChatConversation).toHaveBeenCalledTimes(1);
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

});