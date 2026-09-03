import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as groveApi from '../api/grove';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Home from '../components/Home';
import type { Leaf } from '../components/leaf-types';

vi.mock('../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  cancelLeaf: vi.fn(),
  recheckLeaf: vi.fn(),
}));

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l', branchId: 'b1', title: 't', status: 'succeeded',
  depth: 0, blocking: true, childCount: 0, updatedAt: '2026-08-01T00:00:00Z', ...over,
} as Leaf);

const TREE = { id: 't1', name: 'GitHub MCP Server', goal: 'Wrap the GitHub REST API' };
const BRANCHES = [
  { id: 'b1', title: 'Build the server', treeId: 't1' },
  { id: 'b2', title: 'Fix the defects', treeId: 't1' },
  { id: 'bx', title: 'Somebody else', treeId: 'other' },
];

const show = (leaves: Leaf[], packNames: Record<string, string> = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Home
      leaves={leaves}
      branches={BRANCHES}
      trees={[TREE, { id: 'other', name: 'Other' }]}
      tree={TREE}
      packNames={packNames}
      onStart={() => {}}
      onOpenLeaf={() => {}}
      onOpenTree={() => {}}
      onOpenBranch={() => {}}
    />
  </QueryClientProvider>,
);

describe("a project's screen", () => {
  it('shows verified and claimed as separate figures', async () => {
    show([
      leaf({ id: '1', status: 'succeeded', verified: true }),
      leaf({ id: '2', status: 'succeeded', verified: true }),
      leaf({ id: '3', status: 'succeeded', verified: false }),
    ]);
    await waitFor(() => expect(screen.getByText('2 verified')).toBeInTheDocument());
    expect(screen.getByText('1 claimed')).toBeInTheDocument();
    expect(screen.queryByText(/3 done/i)).not.toBeInTheDocument();
  });

  it('counts a failure as work still left', async () => {
    show([
      leaf({ id: '1', status: 'succeeded', verified: true }),
      leaf({ id: '2', status: 'failed' }),
    ]);
    await waitFor(() => expect(screen.getByText('1 left')).toBeInTheDocument());
  });

  it('separates a failure that just broke from one a finished run left behind', async () => {
    show([
      leaf({ id: 'old', title: 'Left behind', branchId: 'b1', status: 'failed' }),
      leaf({ id: 'new', title: 'Just broke', branchId: 'b2', status: 'failed' }),
      leaf({ id: 'live', title: 'Still going', branchId: 'b2', status: 'running' }),
    ]);
    await waitFor(() => expect(screen.getByText(/Needs you/i)).toBeInTheDocument());
    expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument();

    expect(screen.getAllByText('Just broke')).toHaveLength(1);
    expect(screen.getAllByText('Left behind')).toHaveLength(1);
    expect(screen.getByText(/from .Build the server./)).toBeInTheDocument();
  });

  it('says a thing once, not in two lists at the same time', async () => {
    show([leaf({ id: 'f', title: 'Broken thing', branchId: 'b1', status: 'failed' })]);
    await waitFor(() => expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument());
    expect(screen.getAllByText('Broken thing')).toHaveLength(1);
  });

  it('labels work with who did it, not a pack id', async () => {
    show([leaf({ id: '1', status: 'succeeded', verified: true, packId: 'pk-builder' })], { 'pk-builder': 'Builder' });
    await waitFor(() => expect(screen.getAllByText('Builder').length).toBeGreaterThan(0));
    expect(screen.queryByText('pk-builder')).not.toBeInTheDocument();
  });

  it('does not count another project\'s work', async () => {
    show([
      leaf({ id: 'mine', title: 'Mine', branchId: 'b1', status: 'succeeded', verified: true }),
      leaf({ id: 'theirs', title: 'Theirs', branchId: 'bx', status: 'succeeded', verified: true }),
    ]);
    await waitFor(() => expect(screen.getByText('Mine')).toBeInTheDocument());
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
    expect(screen.getByText('1 verified')).toBeInTheDocument();
  });

  it('lists the project\'s conversations', async () => {
    show([leaf({ id: '1', status: 'succeeded', verified: true })]);
    await waitFor(() => expect(screen.getByText('Build the server')).toBeInTheDocument());
    expect(screen.getByText('Fix the defects')).toBeInTheDocument();
    expect(screen.queryByText('Somebody else')).not.toBeInTheDocument();
  });

  it('offers somewhere to talk about the project, scoped to it', async () => {
    show([leaf({ id: '1', status: 'succeeded', verified: true })]);
    await waitFor(() => expect(screen.getByPlaceholderText(/GitHub MCP Server/)).toBeInTheDocument());
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('groups the work instead of columning it', async () => {
    show([
      leaf({ id: 'f', title: 'Broken', status: 'failed' }),
      leaf({ id: 'v', title: 'Done', status: 'succeeded', verified: true }),
    ]);
    await waitFor(() => expect(screen.getByText(/The work/i)).toBeInTheDocument());
    expect(screen.getByText(/Verified · 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Blocked ·/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Broken')).toHaveLength(1);
    expect(screen.queryByText(/Failed ·/)).not.toBeInTheDocument();
  });
});

describe('dropping outstanding work', () => {
  it('lets you drop a thing the project is not going to do', async () => {
    const { getByTitle } = show([leaf({ id: 'gone', title: 'Not worth it', branchId: 'b1', status: 'failed' })]);
    await waitFor(() => expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument());

    fireEvent.click(getByTitle(/Drop this/i));
    await waitFor(() => expect(groveApi.cancelLeaf).toHaveBeenCalledWith('gone'));
  });

  it('shows why it was not delivered, not just that it was not', async () => {
    show([leaf({
      id: 'f', title: 'Flaky', branchId: 'b1', status: 'failed',
      attempts: [
        { attempt: 0, error: 'first thing', failedAt: '' },
        { attempt: 1, error: 'context_length_exceeded', failedAt: '' },
      ],
    })]);
    await waitFor(() => expect(screen.getByText(/2 attempts/)).toBeInTheDocument());
    expect(screen.getByText(/context_length_exceeded/)).toBeInTheDocument();
  });
});

describe('looking again at a stranded failure', () => {
  it('offers a recheck only when there is a branch to check', async () => {
    show([
      leaf({ id: 'withBranch', title: 'Has a branch', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' }),
      leaf({ id: 'without', title: 'No branch', branchId: 'b1', status: 'failed' }),
    ]);
    await waitFor(() => expect(screen.getByText('Has a branch')).toBeInTheDocument());
    expect(screen.getAllByTitle(/Look again/i)).toHaveLength(1);
  });

  it('shows the answer rather than acting on it silently', async () => {
    vi.mocked(groveApi.recheckLeaf).mockResolvedValue({
      outcome: 'needs-a-look', reason: 'There is work on koala/abc, but this leaf promised no files.',
    });
    show([leaf({ id: 'l', title: 'Stranded', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' })]);
    await waitFor(() => expect(screen.getByTitle(/Look again/i)).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/Look again/i));
    await waitFor(() => expect(screen.getByText(/promised no files/)).toBeInTheDocument());
  });

  it('says so when the repository could not be read', async () => {
    vi.mocked(groveApi.recheckLeaf).mockRejectedValue({ response: { data: { error: 'Could not read the repository: 502' } } });
    show([leaf({ id: 'l', title: 'Stranded', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' })]);
    await waitFor(() => expect(screen.getByTitle(/Look again/i)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/Look again/i));
    await waitFor(() => expect(screen.getByText(/Could not read the repository/)).toBeInTheDocument());
  });
});
