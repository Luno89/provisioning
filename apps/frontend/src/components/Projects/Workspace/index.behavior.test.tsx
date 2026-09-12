import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import * as modelsApi from '../../../api/models';
import * as groveApi from '../../../api/grove';
import * as projectsApi from '../../../api/projects';
import * as personasApi from '../../../api/personas';
import * as harnessApi from '../../../api/harness';
import Workspace from './index';

vi.mock('axios');

vi.mock('../../../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn(),
  listBranches: vi.fn(),
  listLeaves: vi.fn(),
  createBranch: vi.fn(),
  patchBranch: vi.fn(),
  patchTree: vi.fn(),
  deleteBranch: vi.fn(),
  deleteLeaf: vi.fn(),
  acceptLeaf: vi.fn(),
  getLeafTrace: vi.fn(),
}));
vi.mock('../../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjects: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  listModels: vi.fn().mockResolvedValue([
    { id: 'm1', name: 'Model', source: 'deployment', kind: 'tabbyapi', model: 'm' },
  ]),
}));
vi.mock('../../../api/personas', async (importOriginal) => ({
  ...(await importOriginal<typeof personasApi>()),
  listPersonas: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../api/harness', async (importOriginal) => ({
  ...(await importOriginal<typeof harnessApi>()),
  getConfig: vi.fn().mockResolvedValue({ effective: [] }),
}));
vi.mock('../../ProjectEditor/FileTree.js', () => ({ FileTree: () => <div>file-tree</div> }));
vi.mock('../../ProjectEditor/EditorPane.js', () => ({ EditorPane: () => <div>editor-pane</div> }));
vi.mock('../../ProjectEditor/TabBar.js', () => ({ TabBar: () => <div>tab-bar</div> }));
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

const renderWorkspace = (handoff?: { branchId: string; prompt: string }, onHandoffTaken?: () => void) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Workspace treeId="tree-1" {...(handoff ? { handoff } : {})} {...(onHandoffTaken ? { onHandoffTaken } : {})} />
    </QueryClientProvider>,
  );
};

const openBranch = async (title: string) => {
  await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(title)[0]!);
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi({});
  vi.mocked(groveApi.acceptLeaf).mockResolvedValue({} as never);
  mockedAxios.delete.mockResolvedValue({ data: {} });
});

describe('selecting a leaf', () => {
  it('opens the detail view for it', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Token bucket per API key.' })] });
    renderWorkspace();
    await openBranch('Rate limiting work');
    fireEvent.click(screen.getByText('Branches'));
    await waitFor(() => expect(screen.getByText('Add rate limiting')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Add rate limiting'));
    await waitFor(() => expect(screen.getByText('Token bucket per API key.')).toBeInTheDocument());
  });

  it('shows failed attempts, which is the whole reason to open a broken leaf', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'failed', attempts: [{ attempt: 0, error: 'tests did not compile', failedAt: 'x' }] })],
    });
    renderWorkspace();
    await openBranch('Rate limiting work');
    fireEvent.click(screen.getByText('Branches'));
    await waitFor(() => expect(screen.getByText('Add rate limiting')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Add rate limiting'));
    await waitFor(() => expect(screen.getByText('tests did not compile')).toBeInTheDocument());
  });
});

describe('proposals', () => {
  it('offers accept and reject even with no model configured, so proposals are never stranded', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed', packId: 'p1' })] });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByTitle('Accept — starts the work')).toBeInTheDocument());
    expect(screen.getByTitle('Reject')).toBeInTheDocument();
  });

  it('will not let you accept work with nobody assigned to it', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ status: 'proposed' })] });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByText(/needs a persona/i)).toBeInTheDocument());
    expect(screen.getByTitle('Assign a persona first')).toBeDisabled();
    expect(screen.getByTitle('Reject')).not.toBeDisabled();
  });

  it('accepting posts to the accept endpoint with the real leaf id', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Accept — starts the work'));
    await waitFor(() => expect(groveApi.acceptLeaf).toHaveBeenCalledWith('real-id'));
  });

  it('shows accept-all for several, and accepts each one', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'proposed', packId: 'p1' }), leaf({ id: 'leaf-2', title: 'Add metrics', status: 'proposed', packId: 'p1' })],
    });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByText('Accept all')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Accept all'));
    await waitFor(() => expect(groveApi.acceptLeaf).toHaveBeenCalledTimes(2));
    expect(groveApi.acceptLeaf).toHaveBeenCalledWith('leaf-1');
    expect(groveApi.acceptLeaf).toHaveBeenCalledWith('leaf-2');
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
    mockApi({ branches: [branch()], leaves: [] });
    renderWorkspace({ branchId: 'branch-1', prompt: 'One of the leaves on this branch failed. Read the record.' }, taken);

    await waitFor(() => {
      const sent = calls.find((c) => c.url.includes('/chat'));
      expect(sent).toBeTruthy();
      expect(sent!.body).toContain('One of the leaves on this branch failed');
    });
    expect(taken).toHaveBeenCalled();
  });

  it('sends it once, not once per render', async () => {
    const calls = stubChat();
    mockApi({ branches: [branch()], leaves: [] });
    renderWorkspace({ branchId: 'branch-1', prompt: 'Review this failure please.' }, () => {});
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1));
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c.url.includes('/chat')).length).toBe(1);
  });
});

describe('chat mode surviving the panel', () => {
  it('keeps the mode after looking at a leaf and coming back', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Some detail.' })] });
    renderWorkspace();
    await openBranch('Rate limiting work');

    await waitFor(() => expect(screen.getByPlaceholderText(/Send a message/i)).toBeInTheDocument());
    const box = screen.getByPlaceholderText(/Send a message/i);
    fireEvent.change(box, { target: { value: '/chat' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByText('/chat')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Branches'));
    fireEvent.click(screen.getByText('Add rate limiting'));
    await waitFor(() => expect(screen.getByText('Some detail.')).toBeInTheDocument());
    fireEvent.click(screen.getAllByText('Rate limiting work')[0]!);

    await waitFor(() => expect(screen.getByText('/chat')).toBeInTheDocument());
  });
});

describe('an accept the server refuses', () => {
  it('shows why, instead of doing nothing', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
    vi.mocked(groveApi.acceptLeaf).mockRejectedValue({
      response: { data: { error: 'Nothing would check the finished result. Ask the planner to call set_acceptance for this request.' } },
    });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Accept — starts the work'));

    expect(await screen.findByText(/Ask the planner to call set_acceptance/)).toBeInTheDocument();
  });

  it('clears the warning once an accept succeeds', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ id: 'real-id', status: 'proposed', packId: 'p1' })] });
    vi.mocked(groveApi.acceptLeaf).mockRejectedValueOnce({ response: { data: { error: 'Assign a persona first.' } } });
    renderWorkspace();
    await openBranch('Rate limiting work');
    await waitFor(() => expect(screen.getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(screen.getByTitle('Accept — starts the work'));
    expect(await screen.findByText(/Assign a persona first/)).toBeInTheDocument();

    vi.mocked(groveApi.acceptLeaf).mockResolvedValue({} as never);
    fireEvent.click(screen.getByTitle('Accept — starts the work'));
    await waitFor(() => expect(screen.queryByText(/Assign a persona first/)).not.toBeInTheDocument());
  });
});
