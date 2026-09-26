import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import * as modelsApi from '../../../api/models';
import * as groveApi from '../../../api/grove';
import * as projectsApi from '../../../api/projects';
import * as chatPackApi from '../../../api/chat-pack';
import * as engineApi from '../../../api/engine';
import Workspace from './index';

vi.mock('axios');

vi.mock('../../../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn(),
  listBranches: vi.fn(),
  listLeaves: vi.fn(),
  deleteBranch: vi.fn(),
  deleteLeaf: vi.fn(),
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
vi.mock('../../../api/chat-pack', async (importOriginal) => ({
  ...(await importOriginal<typeof chatPackApi>()),
  createChatConversation: vi.fn(),
}));
vi.mock('../../../api/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof engineApi>()),
  startRun: vi.fn(),
}));
vi.mock('../../ProjectEditor/FileTree.js', () => ({ FileTree: () => <div>file-tree</div> }));
vi.mock('../../ProjectEditor/EditorPane.js', () => ({ EditorPane: () => <div>editor-pane</div> }));
vi.mock('../../ProjectEditor/TabBar.js', () => ({ TabBar: () => <div>tab-bar</div> }));
const mockedAxios = vi.mocked(axios);

const leaf = (over: Record<string, unknown> = {}) => ({
  id: 'leaf-1',
  branchId: 'branch-1',
  title: 'Add rate limiting',
  status: 'pending',
  updatedAt: '2026-08-03T00:00:00Z',
  ...over,
});

const branch = (over: Record<string, unknown> = {}) => ({
  id: 'branch-1',
  title: 'Rate limiting work',
  treeId: 'tree-1',
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

const renderWorkspace = (props: { treeId?: string; projectId?: string } = { treeId: 'tree-1' }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Workspace {...props} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApi({});
  mockedAxios.delete.mockResolvedValue({ data: {} });
});

describe('selecting a leaf', () => {
  it('opens the detail view for it', async () => {
    mockApi({ branches: [branch()], leaves: [leaf({ body: 'Token bucket per API key.' })] });
    renderWorkspace();
    await waitFor(() => expect(screen.getAllByText('Add rate limiting').length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText('Add rate limiting')[0]!);
    await waitFor(() => expect(screen.getByText('Token bucket per API key.')).toBeInTheDocument());
  });

  it('shows failed attempts, which is the whole reason to open a broken leaf', async () => {
    mockApi({
      branches: [branch()],
      leaves: [leaf({ status: 'failed', attempts: [{ attempt: 1, error: 'tests did not compile', failedAt: 'x' }] })],
    });
    renderWorkspace();
    await waitFor(() => expect(screen.getAllByText('Add rate limiting').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText('Add rate limiting')[0]!);
    await waitFor(() => expect(screen.getByText('tests did not compile')).toBeInTheDocument());
  });
});

describe('asking for more work on a tree', () => {
  it('opens a conversation about the tree and sends the ask as its first turn', async () => {
    vi.mocked(chatPackApi.createChatConversation).mockResolvedValue({ id: 'conv-tree', title: 'Add metrics', treeId: 'tree-1' });
    vi.mocked(engineApi.startRun).mockResolvedValue({ runId: 'run-1', agentSlug: 'koala', loopId: 'interactive-chat' });
    renderWorkspace();

    const box = await screen.findByPlaceholderText('Ask for more work on Gateway, or ask about what is already there.');
    fireEvent.change(box, { target: { value: 'Add metrics' } });
    fireEvent.click(screen.getByText('Start'));

    await waitFor(() => expect(chatPackApi.createChatConversation).toHaveBeenCalledWith('Add metrics', { treeId: 'tree-1' }));
    await waitFor(() => expect(engineApi.startRun).toHaveBeenCalledWith(expect.objectContaining({ message: 'Add metrics', conversationId: 'conv-tree' })));
    expect(engineApi.startRun).toHaveBeenCalledTimes(1);
  });
});

describe('a project with no tree yet', () => {
  it('starts a koala conversation about the project, which the plan it proposes will be linked to', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{ id: 'proj-1', name: 'gateway', ownerId: 'u' }] as never);
    vi.mocked(chatPackApi.createChatConversation).mockResolvedValue({ id: 'conv-proj', title: 'New conversation', projectId: 'proj-1' });
    mockApi({ trees: [] });
    renderWorkspace({ projectId: 'proj-1' });

    const start = (await screen.findByText('Start a conversation')).closest('button')!;
    await waitFor(() => expect(start).not.toBeDisabled());
    fireEvent.click(start);

    await waitFor(() => expect(chatPackApi.createChatConversation).toHaveBeenCalledWith('New conversation', { projectId: 'proj-1' }));
  });
});
