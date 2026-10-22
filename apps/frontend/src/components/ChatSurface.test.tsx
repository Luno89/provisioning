import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ChatSurface from '../components/ChatSurface.js';
import * as chatPackApi from '../api/chat-pack.js';
import * as engineApi from '../api/engine.js';
import * as autoModeApi from '../api/auto-mode';
import { useLiveTurnsStore, conversationTurnKey } from '../stores/live-turns.js';
import { type EngineEvent } from '../api/engine.js';
import { TURN_LOG_CHANNEL } from '../api/turns';
import type { TurnLogEntry } from '../types/turns';
import * as plansApi from '../api/plans';
import { planKeys } from '../api/plans';
import * as channelApi from '../api/project-channel.js';

vi.mock('../api/chat-pack', async (orig) => ({
  ...(await orig<typeof chatPackApi>()),
  listChatConversations: vi.fn().mockResolvedValue([]),
  getChatConversation: vi.fn().mockImplementation(async (id: string) => ({
    id,
    title: 'Test Conversation',
    messages: [],
  })),
  patchChatConversation: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test Conversation', messages: [] }),
  getConversationContext: vi.fn().mockResolvedValue({ given: {}, text: '' }),
}));

vi.mock('../api/auto-mode', async (orig) => ({
  ...(await orig<typeof import('../api/auto-mode')>()),
  setConversationAutoMode: vi.fn(async (_id: string, on: boolean) => on),
}));
vi.mock('../api/plans', async (orig) => ({
  ...(await orig<typeof plansApi>()),
  listPlans: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/project-channel', async (orig) => ({
  ...(await orig<typeof import('../api/project-channel.js')>()),
  postChannelMessage: vi.fn().mockResolvedValue(undefined),
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
 * arrive on TURN_LOG_CHANNEL as turn log entries via the socket bridge. The mock below keeps a module-level
 * table of the registered handlers so a test can deliver a scripted event stream to the surface
 * exactly as the socket bridge would.
 */
const { socketHandlers, turnLog } = vi.hoisted(() => ({
  socketHandlers: new Map<string, (event: unknown) => void>(),
  turnLog: [] as { turnId: string; seq: number; events: unknown[]; at: string }[],
}));

vi.mock('../api/turns', async (orig) => ({
  ...(await orig<typeof import('../api/turns')>()),
  readTurn: vi.fn(async (turnId: string, after: number) => turnLog.filter((entry) => entry.turnId === turnId && entry.seq > after)),
}));

vi.mock('../features/platform/stores/socket.js', () => ({
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


let runs = 0;
let RUN_ID = 'run-1';
const AT = '2025-01-01T00:00:00.000Z';

type EventSeed = { type: string } & Record<string, unknown>;

function deliver(turnId: string, event: EngineEvent, announce = true) {
  const entry: TurnLogEntry = { turnId, seq: turnLog.filter((one) => one.turnId === turnId).length + 1, events: [event], at: AT };
  turnLog.push(entry as never);
  if (announce) socketHandlers.get(TURN_LOG_CHANNEL)?.(entry);
}

/** Deliver a scripted engine-event stream to the registered socket handler. */
function emit(...seeds: EventSeed[]) {
  for (const seed of seeds) {
    deliver(RUN_ID, { runId: RUN_ID, at: AT, ...(seed as object) } as EngineEvent);
  }
}

/** Wait until sendConversationTurn has posted the /engine/runs start, so the event stream can land. */
async function waitForRunStarted() {
  await waitFor(() => expect(engineApi.startRun).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  socketHandlers.clear();
  turnLog.length = 0;
  runs += 1;
  RUN_ID = `run-${runs}`;
  queryClient.clear();
  useLiveTurnsStore.setState({ turns: {} });
  vi.mocked(engineApi.startRun).mockImplementation(async () => ({ runId: RUN_ID, agentSlug: 'koala', loopId: 'koala-chat' }) as never);
  vi.mocked(engineApi.cancelRun).mockResolvedValue({ ok: true } as never);
  vi.mocked(engineApi.approveRunCall).mockResolvedValue({ ok: true } as never);
  vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
    id,
    title: 'Test Conversation',
    messages: [],
  }) as never);
  vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: {}, text: '' });
  vi.mocked(plansApi.listPlans).mockResolvedValue([]);
  try { localStorage.clear(); } catch { /* none */ }
});

describe('ChatSurface in a channel', () => {
  const NOTE_AT = '2026-10-11T17:59:09.231Z';
  const channelThread = () => vi.mocked(chatPackApi.getChatConversation).mockResolvedValue({
    id: 'channel-p1',
    title: 'Shop',
    messages: [
      { role: 'user', content: 'a note for the team', at: NOTE_AT },
      { role: 'user', content: '@koala what is live?', at: '2026-10-11T18:00:00.000Z', runId: 'run-old' },
      { role: 'assistant', content: 'Slot a.', at: '2026-10-11T18:00:05.000Z', runId: 'run-old' },
    ],
  } as never);

  it('says of each message whether Koala was asked', async () => {
    channelThread();
    renderWithProviders(<ChatSurface conversationId="channel-p1" channel hideSidebar />);
    await screen.findByText('a note for the team');
    const labels = screen.getAllByTestId('message-address').map((one) => one.textContent);
    expect(labels).toEqual(["posted · Koala wasn't askedAsk Koala", 'asked Koala']);
  });

  it('posts a message without @koala to the channel, naming the button for what it does', async () => {
    channelThread();
    renderWithProviders(<ChatSurface conversationId="channel-p1" channel hideSidebar />);
    await screen.findByText('a note for the team');
    const input = screen.getByPlaceholderText(/post to the channel/i);
    fireEvent.change(input, { target: { value: 'the shop opens at 9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(channelApi.postChannelMessage).toHaveBeenCalledWith('channel-p1', 'the shop opens at 9', []));
    expect(engineApi.startRun).not.toHaveBeenCalled();
  });

  it('asks Koala about a posted note without posting it again', async () => {
    channelThread();
    renderWithProviders(<ChatSurface conversationId="channel-p1" channel hideSidebar />);
    await screen.findByText('a note for the team');
    fireEvent.click(screen.getByRole('button', { name: 'Ask Koala' }));
    await waitForRunStarted();
    expect(engineApi.startRun).toHaveBeenCalledWith(expect.objectContaining({ message: 'a note for the team', conversationId: 'channel-p1', asks: NOTE_AT }));
    expect(screen.getAllByText('a note for the team')).toHaveLength(1);
  });

  it('sends every message to Koala once Ask Koala is on, and remembers it for the channel', async () => {
    channelThread();
    const { unmount } = renderWithProviders(<ChatSurface conversationId="channel-p1" channel hideSidebar />);
    await screen.findByText('a note for the team');
    const toggle = screen.getByRole('button', { name: /ask koala: off/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /asking koala/i })).toHaveAttribute('aria-pressed', 'true');
    const input = screen.getByPlaceholderText(/ask koala/i);
    fireEvent.change(input, { target: { value: 'add an e2e test' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toHaveTextContent('Ask Koala');
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitForRunStarted();
    expect(engineApi.startRun).toHaveBeenCalledWith(expect.objectContaining({ message: 'add an e2e test' }));
    expect(vi.mocked(engineApi.startRun).mock.calls[0]![0]).not.toHaveProperty('asks');
    expect(channelApi.postChannelMessage).not.toHaveBeenCalled();
    unmount();
    renderWithProviders(<ChatSurface conversationId="channel-p1" channel hideSidebar />);
    expect(await screen.findByRole('button', { name: /asking koala/i })).toHaveAttribute('aria-pressed', 'true');
  });
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

  it('shows what Koala sees about what the conversation is bound to, above its messages and while it is empty', async () => {
    vi.mocked(chatPackApi.getConversationContext).mockResolvedValue({ given: { treeId: 't1', tree: 'Tree "Shop" (t1).' }, text: 'treeId: t1\n\ntree: Tree "Shop" (t1).' });
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValue({ id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hello from user' }] } as never);
    const { unmount } = renderWithProviders(<ChatSurface conversationId="c1" />);
    await screen.findByText('hello from user');
    const context = await screen.findByTestId('conversation-context');
    expect(context).toHaveTextContent('What Koala sees about this tree');
    expect(context.compareDocumentPosition(screen.getByText('hello from user')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chatPackApi.getConversationContext).toHaveBeenCalledWith('c1');
    unmount();
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValue({ id: 'c2', title: 'T', messages: [] } as never);
    renderWithProviders(<ChatSurface conversationId="c2" pinned intro={<p>Ask Koala</p>} />);
    expect(await screen.findByTestId('chat-intro')).toHaveTextContent('Ask Koala');
    expect(await screen.findByTestId('conversation-context')).toBeInTheDocument();
  });

  it('shows nothing of the sort for a conversation bound to nothing', async () => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValue({ id: 'c1', title: 'T', messages: [{ role: 'user', content: 'hello from user' }] } as never);
    renderWithProviders(<ChatSurface conversationId="c1" />);
    await screen.findByText('hello from user');
    await waitFor(() => expect(chatPackApi.getConversationContext).toHaveBeenCalled());
    expect(screen.queryByTestId('conversation-context')).not.toBeInTheDocument();
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
      { type: 'notice', level: 'warn', nodeId: 'turn.run_command', callId: 'tc1', tool: 'run_command', message: 'Koala wants to run run_command on this run: {"command":"docker compose up"}' },
    );

    const allowText = 'Koala wants to run run_command on this run: {"command":"docker compose up"}';
    const marker = await screen.findByTestId('chat-card-marker');
    expect(marker).toHaveTextContent('Tool call: Run run_command · waits for you');
    expect(screen.getByRole('tab', { name: /Cards/ })).toHaveTextContent('1');
    fireEvent.click(marker);
    expect(screen.getByRole('tab', { name: /Cards/ })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Allow run_command in this chat' })).toBeInTheDocument());
    expect(screen.getByText(allowText)).toBeInTheDocument();
    expect(screen.getByText('run_command {"command":"docker compose up"}')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow run_command in this chat' }));
    await waitFor(() =>
      expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'tc1', allowed: true, conversationId: 'c1', tool: 'run_command' }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow run_command in this chat' })).not.toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: /Cards/ })).not.toBeInTheDocument();

    emit(
      { type: 'tool.result', callId: 'tc1', ok: true, digest: 'compose up done' },
      { type: 'content', delta: 'All up' },
      { type: 'run.finished', outcome: 'ok' },
    );
    await waitFor(() => expect(screen.getByText('All up')).toBeInTheDocument());
  });

  it('answers the call an agent on a machine asks about, and auto mode for the chat lets it through', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'research it' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'tool.called', callId: 'tc9', name: 'research', args: '{"question":"port"}' },
      { type: 'notice', level: 'warn', nodeId: 'work', callId: 'ext-abc', tool: 'antigravity: Write tabby-port.md', message: 'research wants to run antigravity: Write tabby-port.md on OZ-001TallGeese: Write tabby-port.md' },
    );

    fireEvent.click(await screen.findByTestId('chat-card-marker'));
    fireEvent.click(await screen.findByRole('button', { name: 'Auto mode for this chat' }));
    await waitFor(() => expect(autoModeApi.setConversationAutoMode).toHaveBeenCalledWith('c1', true));
    await waitFor(() => expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'ext-abc', allowed: true }));
    expect(await screen.findByRole('button', { name: /Auto mode: on/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows each call asking at once as its own card, answers each by its own call, and lets every one through when auto mode is switched on', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'research it' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitForRunStarted();
    emit(
      { type: 'notice', level: 'warn', nodeId: 'work', callId: 'ext-a', tool: 'antigravity.execute', message: 'research wants to run antigravity.execute on Desk: ls' },
      { type: 'notice', level: 'warn', nodeId: 'work', callId: 'ext-b', tool: 'antigravity.edit', message: 'research wants to run antigravity.edit on Desk: write notes.md' },
      { type: 'notice', level: 'warn', nodeId: 'work', callId: 'ext-c', tool: 'antigravity.fetch', message: 'research wants to run antigravity.fetch on Desk: fetch' },
    );

    expect(await screen.findByRole('tab', { name: /Cards/ })).toHaveTextContent('3');
    fireEvent.click(screen.getByRole('tab', { name: /Cards/ }));
    expect(await screen.findByText('research wants to run antigravity.execute on Desk: ls')).toBeInTheDocument();
    expect(screen.getByText('research wants to run antigravity.edit on Desk: write notes.md')).toBeInTheDocument();

    const denies = screen.getAllByRole('button', { name: 'Deny' });
    expect(denies).toHaveLength(3);
    fireEvent.click(denies[1]!);
    await waitFor(() => expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'ext-b', allowed: false }));
    await waitFor(() => expect(screen.queryByText('research wants to run antigravity.edit on Desk: write notes.md')).not.toBeInTheDocument());

    emit({ type: 'tool.result', callId: 'ext-c', ok: true, digest: 'answered elsewhere' });
    await waitFor(() => expect(screen.queryByText('research wants to run antigravity.fetch on Desk: fetch')).not.toBeInTheDocument());
    emit({ type: 'notice', level: 'warn', nodeId: 'work', callId: 'ext-d', tool: 'antigravity.execute', message: 'research wants to run antigravity.execute on Desk: pwd' });

    fireEvent.click(await screen.findByRole('button', { name: /Auto mode: off/ }));
    await waitFor(() => expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'ext-a', allowed: true }));
    await waitFor(() => expect(engineApi.approveRunCall).toHaveBeenCalledWith(RUN_ID, { callId: 'ext-d', allowed: true }));
    expect(engineApi.approveRunCall).toHaveBeenCalledTimes(3);
  });

  it('switches the chat\u2019s auto mode on and back off beside the model', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.click(await screen.findByRole('button', { name: /Auto mode: off/ }));
    await waitFor(() => expect(autoModeApi.setConversationAutoMode).toHaveBeenLastCalledWith('c1', true));
    fireEvent.click(await screen.findByRole('button', { name: /Auto mode: on/ }));
    await waitFor(() => expect(autoModeApi.setConversationAutoMode).toHaveBeenLastCalledWith('c1', false));
    expect(await screen.findByRole('button', { name: /Auto mode: off/ })).toHaveAttribute('aria-pressed', 'false');
    expect(engineApi.approveRunCall).not.toHaveBeenCalled();
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
        .toHaveBeenCalledWith('c1', { modelId: 'm2', agentSlug: 'koala', modelReach: 'handoffs' }),
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
describe('a turn drawn from its log', () => {
  it('draws a turn already under way when the conversation loads, from the start of its log, then follows it', async () => {
    deliver('run-earlier', { runId: 'run-earlier', at: AT, type: 'content', nodeId: 'turn', delta: 'Halfway through ' } as EngineEvent, false);
    deliver('run-earlier', { runId: 'run-earlier', at: AT, type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'get_logs', args: '{}' } as EngineEvent, false);
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({
      id, title: 'Mid-turn', liveTurn: { runId: 'run-earlier', startedAt: AT },
      messages: [{ role: 'user', content: 'what is wrong?', at: AT }],
    }) as never);

    renderWithProviders(<ChatSurface conversationId="c1" />);

    await waitFor(() => expect(screen.getByText(/Halfway through/)).toBeInTheDocument());
    expect(screen.getByText('get_logs')).toBeInTheDocument();
    expect(engineApi.startRun).not.toHaveBeenCalled();

    deliver('run-earlier', { runId: 'run-earlier', at: AT, type: 'content', nodeId: 'turn', delta: 'and done.' } as EngineEvent);
    await waitFor(() => expect(screen.getByText(/Halfway through and done\./)).toBeInTheDocument());
  });

  it('fills in what the push missed from the log, so nothing written is lost', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitForRunStarted();

    emit({ type: 'content', delta: 'one ' });
    deliver(RUN_ID, { runId: RUN_ID, at: AT, type: 'content', nodeId: 'turn', delta: 'two ' } as EngineEvent, false);
    emit({ type: 'content', delta: 'three' });

    await waitFor(() => expect(screen.getByText('one two three')).toBeInTheDocument());
    emit({ type: 'run.finished', outcome: 'ok' });
  });
});

describe('a hand-off\'s run in the chat', () => {
  it('draws the child run under its call while it works, keeps the turn going when it ends, and refreshes plans as soon as one is proposed', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'plan it' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitForRunStarted();

    const child = (seed: EventSeed) => deliver(RUN_ID, { runId: `${RUN_ID}-planner-1`, at: AT, ...(seed as object) } as EngineEvent);
    emit({ type: 'tool.called', nodeId: 'tools', callId: 'c1', name: 'planner', args: '{}' });
    child({ type: 'run.started', agentId: 'planner', loopId: 'planning', parentRunId: RUN_ID, parentCallId: 'c1' });
    child({ type: 'tool.called', nodeId: 'tools', callId: 'p1', name: 'propose_plan', args: '{}' });

    await waitFor(() => expect(screen.getByText('propose_plan')).toBeInTheDocument());
    expect(screen.getByText('working — 1 step so far')).toBeInTheDocument();

    invalidate.mockClear();
    child({ type: 'tool.result', nodeId: 'tools', callId: 'p1', ok: true, digest: 'proposed plan p-9' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: planKeys.all });

    child({ type: 'run.finished', outcome: 'ok' });
    await waitFor(() => expect(screen.getByText('finished — 1 step')).toBeInTheDocument());
    expect(engineApi.cancelRun).not.toHaveBeenCalled();
    expect(useLiveTurnsStore.getState().turns[conversationTurnKey('c1')]?.status).toBe('streaming');

    child({ type: 'content', nodeId: 'turn', delta: 'a stray event after it ended' });
    emit({ type: 'run.finished', outcome: 'ok' });
  });

  it('ignores runs that belong to nobody in this turn', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    await waitForRunStarted();

    deliver('other-turn', { runId: 'someone-else', at: AT, type: 'run.started', agentId: 'research', loopId: 'research', parentRunId: 'other-run', parentCallId: 'c1' } as EngineEvent);
    deliver('other-turn', { runId: 'someone-else', at: AT, type: 'tool.called', nodeId: 'tools', callId: 'z', name: 'search_web', args: '{}' } as EngineEvent);

    expect(screen.queryByText('search_web')).not.toBeInTheDocument();
    emit({ type: 'run.finished', outcome: 'ok' });
  });
});

describe('ChatSurface cards', () => {
  const plan = (id: string, status: 'proposed' | 'adopted', createdAt: string, name: string) => ({
    id, ownerId: 'u1', conversationId: 'c1', status, createdAt, updatedAt: createdAt,
    plan: { tree: { type: 'odoo-addons', name }, branches: [] },
  });

  beforeEach(() => {
    vi.mocked(chatPackApi.getChatConversation).mockResolvedValue({
      id: 'c1',
      title: 'T',
      messages: [
        { role: 'user', content: 'make a label', at: '2026-10-14T10:00:00.000Z' },
        { role: 'assistant', content: 'Here is a plan.', at: '2026-10-14T10:00:05.000Z' },
        { role: 'user', content: 'and the dates', at: '2026-10-14T10:05:00.000Z' },
        { role: 'assistant', content: 'Here is another.', at: '2026-10-14T10:05:05.000Z' },
      ],
    } as never);
    vi.mocked(plansApi.listPlans).mockResolvedValue([
      plan('p1', 'adopted', '2026-10-14T10:00:04.000Z', 'Labels'),
      plan('p2', 'proposed', '2026-10-14T10:05:04.000Z', 'Dates'),
    ] as never);
  });

  it('puts the cards in a column beside a wide chat, waiting ones first, with a marker where each was raised', async () => {
    const wide = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 1400 } as DOMRect);
    try {
      renderWithProviders(<ChatSurface conversationId="c1" />);
      const column = await screen.findByRole('complementary', { name: 'Cards' });
      await waitFor(() => expect(column.querySelectorAll('[data-testid="chat-card"]')).toHaveLength(2));
      expect(column).toHaveTextContent('1 waiting for you');
      expect(Array.from(column.querySelectorAll('[data-testid="plan-proposal"]')).map((card) => card.textContent)).toEqual([
        expect.stringContaining('“Dates”'),
        expect.stringContaining('“Labels”'),
      ]);
      expect(screen.queryByRole('tab', { name: /Cards/ })).not.toBeInTheDocument();

      const markers = screen.getAllByTestId('chat-card-marker');
      expect(markers.map((marker) => marker.textContent)).toEqual([
        'Plan: New odoo-addons tree “Labels” · approved',
        'Plan: New odoo-addons tree “Dates” · waits for you',
      ]);
      expect(screen.getByText('make a label').compareDocumentPosition(markers[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(markers[0]!.compareDocumentPosition(screen.getByText('Here is a plan.')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(markers[0]!);
      expect(column.querySelector('[data-focused="true"]')).toHaveTextContent('“Labels”');
    } finally {
      wide.mockRestore();
    }
  });

  it('keeps them on a Cards tab in a narrow chat, counting the ones that wait for you', async () => {
    renderWithProviders(<ChatSurface conversationId="c1" />);
    const tab = await screen.findByRole('tab', { name: /Cards/ });
    expect(tab).toHaveTextContent('1');
    expect(screen.queryByRole('complementary', { name: 'Cards' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-cards')).not.toBeInTheDocument();

    fireEvent.click(tab);
    await waitFor(() => expect(screen.getAllByTestId('chat-card')).toHaveLength(2));
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.queryByTestId('chat-cards')).not.toBeInTheDocument();
  });
});

describe('ChatSurface following the address', () => {
  it('stops showing a conversation once the address no longer names it', async () => {
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([{ id: 'c2', title: 'Latest', updatedAt: 'b' }] as never);
    vi.mocked(chatPackApi.getChatConversation).mockImplementation(async (id: string) => ({ id, title: id, messages: [{ role: 'user', content: `said in ${id}`, at: '2026-10-14T10:00:00.000Z' }] }) as never);
    const { rerender } = renderWithProviders(<ChatSurface conversationId="c1" />);
    expect(await screen.findByText('said in c1')).toBeInTheDocument();

    rerender(<QueryClientProvider client={queryClient}><ChatSurface /></QueryClientProvider>);
    expect(await screen.findByText('said in c2')).toBeInTheDocument();
    expect(screen.queryByText('said in c1')).not.toBeInTheDocument();
    vi.mocked(chatPackApi.listChatConversations).mockResolvedValue([]);
  });
});
