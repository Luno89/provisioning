import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import * as modelsApi from '../api/models';
import * as groveApi from '../api/grove';
import * as personasApi from '../api/personas';
import * as harnessApi from '../api/harness';
import Grove from '../components/Grove';

/**
 * Wiring tests for the Koala surface.
 *
 * These exist because every bug found in this UI so far was a WIRING bug that passing unit tests
 * missed — stripProposalBlock written and never called, the transcript discarded on a click, the
 * proposal panel acting on parsed text instead of real records. jsdom cannot see layout, so it
 * will never catch a stray scrollbar; it catches exactly the class of thing that has actually
 * been breaking.
 *
 * Ported from Workspace, which Grove replaced. The behaviours are unchanged and worth keeping
 * pinned; only the component holding them moved. What is new here is the tree level: a branch now
 * lives under a tree and is not visible until that tree is open, so every test opens one first.
 */
// Grove itself still calls axios directly. Its Chat descendant does not — it goes through the api
// modules, which `vi.mock('axios')` cannot reach (api/client owns its own `axios.create()`
// instance). Both are mocked until Grove is converted too.
vi.mock('axios');

vi.mock('../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn(),
  listBranches: vi.fn(),
  listLeaves: vi.fn(),
  createBranch: vi.fn(),
  patchBranch: vi.fn(),
  deleteTree: vi.fn(),
  deleteBranch: vi.fn(),
  deleteLeaf: vi.fn(),
  acceptLeaf: vi.fn(),
  getLeafTrace: vi.fn(),
}));
vi.mock('../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  listModels: vi.fn().mockResolvedValue([
    { id: 'm1', name: 'Model', source: 'deployment', kind: 'tabbyapi', model: 'm' },
  ]),
}));
vi.mock('../api/personas', async (importOriginal) => ({
  ...(await importOriginal<typeof personasApi>()),
  listPersonas: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof harnessApi>()),
  getConfig: vi.fn().mockResolvedValue({ effective: [] }),
}));
const mockedAxios = vi.mocked(axios);

const leaf = (over: Record<string, unknown> = {}) => ({
  id: 'leaf-1',
  branchId: 'branch-1',
  title: 'Add rate limiting',
  column: 'todo',
  status: 'pending',
  depth: 0,
  blocking: true,
  childCount: 0,
  ...over,
});

/**
 * The tree lives in the <aside>. Scoping to it matters: a branch is NAMED after its first root
 * leaf, so the same text legitimately appears twice, and an unscoped getByText throws on the
 * ambiguity rather than finding nothing.
 */
const tree = () => within(document.querySelector('aside')!);
const detail = () => within(document.querySelector('section')!);

/**
 * Opens a branch in the tree.
 *
 * Necessary because the proposal panel is scoped to the OPEN branch — a fresh session starts on a
 * new empty one, so a fixture leaf on some other branch correctly shows nothing until selected.
 */
const openBranch = async (title: string) => {
  await waitFor(() => expect(tree().getAllByText(title).length).toBeGreaterThan(0));
  fireEvent.click(tree().getAllByText(title)[0]!);
};

const renderGrove = (handoff?: { branchId: string; prompt: string }, onHandoffTaken?: () => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Grove {...(handoff ? { handoff } : {})} {...(onHandoffTaken ? { onHandoffTaken } : {})} />
    </QueryClientProvider>,
  );
};

/**
 * Opens the tree the fixtures are filed under.
 *
 * Grove scopes branches to a tree, so nothing below one is reachable until it is expanded. Clicking
 * the NAME both selects and expands; the chevron beside it only expands, which is the distinction
 * this navigator got wrong at first.
 */
const openTree = async (name = 'Gateway') => {
  await waitFor(() => expect(tree().getByText(name)).toBeInTheDocument());
  fireEvent.click(tree().getByText(name));
};

const branch = (over: Record<string, unknown> = {}) => ({
  id: 'branch-1',
  title: 'Rate limiting work',
  messages: [],
  treeId: 'tree-1',
  updatedAt: '2026-08-03T00:00:00Z',
  ...over,
});

const TREES = [{ id: 'tree-1', name: 'Gateway', type: 'api-service', branchCount: 1, updatedAt: '2026-08-03T00:00:00Z' }];

/**
 * Three collections, named rather than routed by URL substring.
 *
 * The old version matched on the path and had to order its checks carefully — `/board` before
 * `/trees` because one URL contained the other, with a comment explaining that trap. Naming the
 * calls removes the trap entirely, and the `/board` branch turned out to be DEAD: no component
 * fetches it any more, and nothing noticed because a URL matcher fails silently into its default.
 */
const mockApi = ({ branches = [] as unknown[], leaves = [] as unknown[], trees = TREES as unknown[] }) => {
  vi.mocked(groveApi.listTrees).mockResolvedValue(trees as never);
  vi.mocked(groveApi.listBranches).mockResolvedValue(branches as never);
  vi.mocked(groveApi.listLeaves).mockResolvedValue(leaves as never);
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes('/models')) return Promise.resolve({ data: [{ id: 'm1', name: 'Model', source: 'deployment', kind: 'tabbyapi' }] });
    return Promise.resolve({ data: [] });
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  /**
   * Grove remembers which tree was open — in localStorage AND in the URL, both deliberate. Both
   * also leak between tests in one jsdom document, so a test that expanded a tree left the next
   * one starting expanded with its chevron already reading "Collapse".
   */
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  mockApi({});
  vi.mocked(groveApi.acceptLeaf).mockResolvedValue({} as never);
  mockedAxios.delete.mockResolvedValue({ data: {} });
});

describe('the tree', () => {
  it('renders a branch with its leaves nested under it', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf(), leaf({ id: 'leaf-2', title: 'Add metrics', parentLeafId: 'leaf-1', depth: 1 })],
    });
    renderGrove();
    await openTree();
    // The branch has its OWN title now, so it no longer collides with its first leaf's.
    await waitFor(() => expect(tree().getByText('Rate limiting work')).toBeInTheDocument());
    expect(tree().getByText('Add rate limiting')).toBeInTheDocument();
    expect(tree().getByText('Add metrics')).toBeInTheDocument();
  });

  it('shows a branch that has produced no leaves yet', async () => {
    // Branches are server records now, so one exists before it has grown anything — which is what
    // makes a title and transcript survive a reload.
    mockApi({ branches: [branch({ title: 'Empty conversation' })] });
    renderGrove();
    await openTree();
    await waitFor(() => expect(tree().getByText('Empty conversation')).toBeInTheDocument());
  });

  it('still shows leaves whose branch record is missing, rather than hiding the work', async () => {
    // A branch record deleted out from under its leaves must not make them vanish from the tree.
    mockApi({ branches: [], leaves: [leaf()] });
    renderGrove();
    // With no branch record it lands in Unfiled, which must still be reachable.
    await openTree('Unfiled');
    await waitFor(() => expect(tree().getAllByText('Add rate limiting').length).toBeGreaterThan(0));
  });
});

describe('expanding a tree versus choosing one', () => {
  /**
   * Reported as "the view should not change when the dropdown is open", and it was two bugs: the
   * row's click did both jobs, AND the pane keyed off which tree was EXPANDED rather than which was
   * selected. Reaching for a disclosure triangle threw away whatever you were reading.
   */
  it('expands without disturbing the pane', async () => {
    mockApi({ branches: [branch()], leaves: [leaf()] });
    renderGrove();
    await waitFor(() => expect(tree().getByText('Gateway')).toBeInTheDocument());
    // The landing is showing.
    expect(screen.getByText(/What should Koala build/i)).toBeInTheDocument();

    fireEvent.click(tree().getByTitle('Expand tree'));

    // The tree opened...
    await waitFor(() => expect(tree().getByText('Rate limiting work')).toBeInTheDocument());
    // ...and the pane did not move.
    expect(screen.getByText(/What should Koala build/i)).toBeInTheDocument();
  });

  it('collapses again without disturbing the pane', async () => {
    mockApi({ branches: [branch()], leaves: [leaf()] });
    renderGrove();
    await waitFor(() => expect(tree().getByText('Gateway')).toBeInTheDocument());

    fireEvent.click(tree().getByTitle('Expand tree'));
    await waitFor(() => expect(tree().getByText('Rate limiting work')).toBeInTheDocument());
    fireEvent.click(tree().getByTitle('Collapse tree'));

    await waitFor(() => expect(tree().queryByText('Rate limiting work')).not.toBeInTheDocument());
    expect(screen.getByText(/What should Koala build/i)).toBeInTheDocument();
  });

  it('opens the board when the tree itself is chosen', async () => {
    // The other half: choosing a tree must still do something, or the row would be inert.
    mockApi({ branches: [branch()], leaves: [leaf()] });
    renderGrove();
    await waitFor(() => expect(tree().getByText('Gateway')).toBeInTheDocument());

    fireEvent.click(tree().getByText('Gateway'));
    await waitFor(() => expect(screen.queryByText(/What should Koala build/i)).not.toBeInTheDocument());
  });
});

describe('selecting a leaf', () => {
  it('opens the detail view for it', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Token bucket per API key.' })] });
    renderGrove();
    await openTree();
    await waitFor(() => expect(tree().getByText('Add rate limiting')).toBeInTheDocument());

    fireEvent.click(tree().getByText('Add rate limiting'));
    // The body only appears in the detail pane, so its presence proves the switch happened.
    await waitFor(() => expect(detail().getByText('Token bucket per API key.')).toBeInTheDocument());
  });

  it('shows failed attempts, which is the whole reason to open a broken leaf', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'failed', attempts: [{ attempt: 0, error: 'tests did not compile', failedAt: 'x' }] })],
    });
    renderGrove();
    await openTree();
    await waitFor(() => expect(tree().getByText('Add rate limiting')).toBeInTheDocument());
    fireEvent.click(tree().getByText('Add rate limiting'));
    await waitFor(() => expect(detail().getByText('tests did not compile')).toBeInTheDocument());
  });
});

describe('proposals', () => {
  it('offers accept and reject even with no model configured, so proposals are never stranded', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', personaId: 'p1' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    expect(detail().getByTitle('Reject')).toBeInTheDocument();
  });

  it('will not let you accept work with nobody assigned to it', async () => {
    /**
     * A persona carries the whole environment — image, network, tools, budget, where the output
     * goes — so a leaf without one cannot run. Accepting it would start work that fails later for a
     * reason nothing on this screen explained.
     */
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByText(/needs a persona/i)).toBeInTheDocument());
    expect(detail().getByTitle('Assign a persona first')).toBeDisabled();
    // Rejecting stays available: a proposal you do not want should not need an assignee first.
    expect(detail().getByTitle('Reject')).not.toBeDisabled();
  });

  it('accepting posts to the accept endpoint with the real leaf id', async () => {
    // The panel used to be built from parsed model text; it must act on the actual record, since
    // the server's extractor is what created it and the two can differ.
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', personaId: 'p1' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(detail().getByTitle('Accept — starts the work'));
    await waitFor(() =>
      expect(groveApi.acceptLeaf).toHaveBeenCalledWith('real-id'),
    );
  });

  it('offers accept-all only when more than one is proposed', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', personaId: 'p1' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    // One proposal: accept-all would be a second button doing the same thing.
    expect(detail().queryByText('Accept all')).not.toBeInTheDocument();
  });

  it('shows accept-all for several, and accepts each one', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'proposed', personaId: 'p1' }), leaf({ id: 'leaf-2', title: 'Add metrics', status: 'proposed', personaId: 'p1' })],
    });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByText('Accept all')).toBeInTheDocument());

    fireEvent.click(detail().getByText('Accept all'));
    await waitFor(() => expect(groveApi.acceptLeaf).toHaveBeenCalledTimes(2));
    expect(groveApi.acceptLeaf).toHaveBeenCalledWith('leaf-1');
    expect(groveApi.acceptLeaf).toHaveBeenCalledWith('leaf-2');
  });

  it('does not show proposed leaves as ordinary work in the tree', async () => {
    /**
     * A proposal is not work yet; it must be visually distinct from an accepted leaf.
     *
     * Asserted on the state the UI shows rather than the raw API status. The dot used to be titled
     * `proposed` — the wire value — which meant the tree spoke a different language from the board
     * beside it. Both say "To do" now, and that agreement is the thing worth pinning.
     */
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', personaId: 'p1' })] });
    renderGrove();
    await openTree();
    await waitFor(() => expect(screen.getAllByTitle('To do').length).toBeGreaterThan(0));
  });
});


describe('a failure handed over from the board', () => {
  /**
   * The chat turn goes out over `fetch`, not axios — it is streamed. Stubbed to a complete,
   * immediately-closed SSE body so the send path runs end to end without a server.
   */
  const stubChat = () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return {
        ok: true,
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true, value: undefined };
                done = true;
                return { done: false, value: new TextEncoder().encode('data: [DONE]\n\n') };
              },
            };
          },
        },
      };
    }));
    return calls;
  };

  afterEach(() => vi.unstubAllGlobals());

  it("opens the leaf's conversation and asks for the review without the user typing", async () => {
    /**
     * The whole point of the hand-off. Landing on an empty box would mean describing the failure by
     * hand — and the evidence would never reach the transcript, so a follow-up could not be answered.
     */
    const calls = stubChat();
    const taken = vi.fn();
    renderGrove({ branchId: 'branch-1', prompt: 'One of the leaves on this branch failed. Read the record.' }, taken);

    await waitFor(() => {
      const sent = calls.find((c) => c.url.includes('/chat'));
      expect(sent).toBeTruthy();
      expect(sent!.body).toContain('One of the leaves on this branch failed');
    });
    // Cleared, so a re-render does not send it again.
    expect(taken).toHaveBeenCalled();
  });

  it('sends it once, not once per render', async () => {
    // sendMessage closes over `messages`, so the effect re-runs as the reply streams in. Without
    // the guard the review is re-sent on every chunk.
    const calls = stubChat();
    renderGrove({ branchId: 'branch-1', prompt: 'Review this failure please.' }, () => {});
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1);
  });
});

describe('chat mode surviving the navigator', () => {
  /**
   * ── THE REGRESSION ──
   * Mode lived inside BranchChat, and BranchChat unmounts every time a leaf is selected. So typing
   * `/chat`, clicking a leaf to look at something and coming back silently put you back in `auto`,
   * where the next message starts extracting work you did not ask for. Nothing said it had changed.
   */
  it('keeps the mode after looking at a leaf and coming back', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Some detail.' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');

    // Switch to chat mode the way a person does.
    await waitFor(() => expect(detail().getByPlaceholderText(/Send a message/i)).toBeInTheDocument());
    const box = detail().getByPlaceholderText(/Send a message/i);
    fireEvent.change(box, { target: { value: '/chat' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(detail().getByText('/chat')).toBeInTheDocument());

    // Look at a leaf, then come back to the conversation.
    fireEvent.click(tree().getByText('Add rate limiting'));
    await waitFor(() => expect(detail().getByText('Some detail.')).toBeInTheDocument());
    fireEvent.click(tree().getAllByText('Rate limiting work')[0]!);

    // Still in chat, not silently back in auto.
    await waitFor(() => expect(detail().getByText('/chat')).toBeInTheDocument());
  });

  it('keeps two conversations in different modes', async () => {
    /**
     * Per branch, not global. One conversation being planned and another merely discussed is
     * normal, and a single setting would flip both.
     */
    mockApi({
      branches: [branch(), branch({ id: 'branch-2', title: 'Second conversation' })],
      leaves: [leaf()],
    });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');

    const box = () => detail().getByPlaceholderText(/Send a message/i);
    await waitFor(() => expect(box()).toBeInTheDocument());
    fireEvent.change(box(), { target: { value: '/chat' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(detail().getByText('/chat')).toBeInTheDocument());

    // The other conversation is untouched by that.
    fireEvent.click(tree().getAllByText('Second conversation')[0]!);
    await waitFor(() => expect(detail().getByText('/auto')).toBeInTheDocument());
  });
});


describe('an accept the server refuses', () => {
  /**
   * ── THE BUG ──
   * Reported as "I can't click accept" on the second branch of a tree. There was no `onError`, so a
   * 409 went nowhere: the button did nothing, no message appeared, and the leaf sat there looking
   * clickable.
   *
   * The second branch is exactly where it bites. The acceptance-plan guard is checked per BRANCH and
   * a second branch starts with none — measured on the live database, every FIRST branch had one
   * check and every second had zero, with its leaves stuck at `proposed`.
   *
   * The refusals are all actionable ("assign a persona", "ask the planner to call set_acceptance"),
   * which is worth nothing while they are swallowed.
   */
  it('shows why, instead of doing nothing', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', personaId: 'p1' })] });
    vi.mocked(groveApi.acceptLeaf).mockRejectedValue({
      response: { data: { error: 'Nothing would check the finished result. Ask the planner to call set_acceptance for this request.' } },
    });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(detail().getByTitle('Accept — starts the work'));

    expect(await screen.findByText(/Ask the planner to call set_acceptance/)).toBeInTheDocument();
  });

  it('clears the warning once an accept succeeds', async () => {
    // A refusal that outlives the problem is its own bug: the next accept works and the banner
    // still says it did not.
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', personaId: 'p1' })] });
    vi.mocked(groveApi.acceptLeaf).mockRejectedValueOnce({ response: { data: { error: 'Assign a persona first.' } } });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(detail().getByTitle('Accept — starts the work'));
    expect(await screen.findByText(/Assign a persona first/)).toBeInTheDocument();

    vi.mocked(groveApi.acceptLeaf).mockResolvedValue({} as never);
    fireEvent.click(detail().getByTitle('Accept — starts the work'));
    await waitFor(() => expect(screen.queryByText(/Assign a persona first/)).not.toBeInTheDocument());
  });
});
