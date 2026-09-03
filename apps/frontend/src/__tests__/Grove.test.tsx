import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import * as modelsApi from '../api/models';
import * as groveApi from '../api/grove';
import * as personasApi from '../api/personas';
import * as harnessApi from '../api/harness';
import Grove from '../components/Grove';

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

const tree = () => within(document.querySelector('aside')!);
const detail = () => within(document.querySelector('section')!);

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
    await waitFor(() => expect(tree().getByText('Rate limiting work')).toBeInTheDocument());
    expect(tree().getByText('Add rate limiting')).toBeInTheDocument();
    expect(tree().getByText('Add metrics')).toBeInTheDocument();
  });

  it('shows a branch that has produced no leaves yet', async () => {
    mockApi({ branches: [branch({ title: 'Empty conversation' })] });
    renderGrove();
    await openTree();
    await waitFor(() => expect(tree().getByText('Empty conversation')).toBeInTheDocument());
  });

  it('still shows leaves whose branch record is missing, rather than hiding the work', async () => {
    mockApi({ branches: [], leaves: [leaf()] });
    renderGrove();
    await openTree('Unfiled');
    await waitFor(() => expect(tree().getAllByText('Add rate limiting').length).toBeGreaterThan(0));
  });
});

describe('expanding a tree versus choosing one', () => {
  it('expands without disturbing the pane', async () => {
    mockApi({ branches: [branch()], leaves: [leaf()] });
    renderGrove();
    await waitFor(() => expect(tree().getByText('Gateway')).toBeInTheDocument());
    expect(screen.getByText(/What should Koala build/i)).toBeInTheDocument();

    fireEvent.click(tree().getByTitle('Expand tree'));

    await waitFor(() => expect(tree().getByText('Rate limiting work')).toBeInTheDocument());
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
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', packId: 'p1' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    expect(detail().getByTitle('Reject')).toBeInTheDocument();
  });

  it('will not let you accept work with nobody assigned to it', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByText(/needs a persona/i)).toBeInTheDocument());
    expect(detail().getByTitle('Assign a persona first')).toBeDisabled();
    expect(detail().getByTitle('Reject')).not.toBeDisabled();
  });

  it('accepting posts to the accept endpoint with the real leaf id', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
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
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', packId: 'p1' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    expect(detail().queryByText('Accept all')).not.toBeInTheDocument();
  });

  it('shows accept-all for several, and accepts each one', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'proposed', packId: 'p1' }), leaf({ id: 'leaf-2', title: 'Add metrics', status: 'proposed', packId: 'p1' })],
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
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', packId: 'p1' })] });
    renderGrove();
    await openTree();
    await waitFor(() => expect(screen.getAllByTitle('To do').length).toBeGreaterThan(0));
  });
});

describe('a failure handed over from the board', () => {
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
    const calls = stubChat();
    const taken = vi.fn();
    renderGrove({ branchId: 'branch-1', prompt: 'One of the leaves on this branch failed. Read the record.' }, taken);

    await waitFor(() => {
      const sent = calls.find((c) => c.url.includes('/chat'));
      expect(sent).toBeTruthy();
      expect(sent!.body).toContain('One of the leaves on this branch failed');
    });
    expect(taken).toHaveBeenCalled();
  });

  it('sends it once, not once per render', async () => {
    const calls = stubChat();
    renderGrove({ branchId: 'branch-1', prompt: 'Review this failure please.' }, () => {});
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1);
  });
});

describe('chat mode surviving the navigator', () => {
  it('keeps the mode after looking at a leaf and coming back', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Some detail.' })] });
    renderGrove();
    await openTree();
    await openBranch('Rate limiting work');

    await waitFor(() => expect(detail().getByPlaceholderText(/Send a message/i)).toBeInTheDocument());
    const box = detail().getByPlaceholderText(/Send a message/i);
    fireEvent.change(box, { target: { value: '/chat' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(detail().getByText('/chat')).toBeInTheDocument());

    fireEvent.click(tree().getByText('Add rate limiting'));
    await waitFor(() => expect(detail().getByText('Some detail.')).toBeInTheDocument());
    fireEvent.click(tree().getAllByText('Rate limiting work')[0]!);

    await waitFor(() => expect(detail().getByText('/chat')).toBeInTheDocument());
  });

  it('keeps two conversations in different modes', async () => {
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

    fireEvent.click(tree().getAllByText('Second conversation')[0]!);
    await waitFor(() => expect(detail().getByText('/auto')).toBeInTheDocument());
  });
});

describe('an accept the server refuses', () => {
  it('shows why, instead of doing nothing', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
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
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
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
