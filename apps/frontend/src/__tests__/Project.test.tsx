import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import * as groveApi from '../api/grove';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Home from '../components/Home';
import type { Leaf } from '../components/leaf-types';

/**
 * One project's screen.
 *
 * ── PORTED FROM THE BOARD ──
 * These assertions came from TreeBoard, which this replaced. Not one of them was about COLUMNS —
 * they were about the rollup, keeping a claim apart from a verification, naming what a blocked leaf
 * waits on, and labelling work with who did it. All of that survives a list, which is the argument
 * for having dropped the columns: they showed exactly one attribute, state, that every row already
 * carried, and spent the whole width doing it.
 */

/**
 * Mocked at the API module, not at axios — `vi.mock('axios')` cannot reach the instance
 * `api/client` builds with `axios.create()`.
 *
 * It also names the two verbs apart. The axios version stubbed `post` for BOTH cancel and recheck,
 * so a test setting up a recheck response was also silently changing what cancel returned.
 */
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

const show = (leaves: Leaf[], personaNames: Record<string, string> = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Home
      leaves={leaves}
      branches={BRANCHES}
      trees={[TREE, { id: 'other', name: 'Other' }]}
      tree={TREE}
      personaNames={personaNames}
      onStart={() => {}}
      onOpenLeaf={() => {}}
      onOpenTree={() => {}}
      onOpenBranch={() => {}}
    />
  </QueryClientProvider>,
);

describe("a project's screen", () => {
  it('shows verified and claimed as separate figures', async () => {
    /**
     * The one assertion worth defending anywhere it appears. `verified` means a check ran;
     * `succeeded` means the agent said so. A single "3 done" launders the claim into a fact at the
     * one place a person looks fastest.
     */
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
    /**
     * The distinction the page turns on. A failure from a conversation still in flight has just
     * broken; one from a run that finished last night is a decision to make. They rendered
     * identically, so three overnight failures sat at the top of the page all day with no way to
     * clear them except deleting the leaf.
     */
    show([
      // b1 has nothing live, so its failure is owed rather than urgent.
      leaf({ id: 'old', title: 'Left behind', branchId: 'b1', status: 'failed' }),
      // b2 is still going, so its failure is live.
      leaf({ id: 'new', title: 'Just broke', branchId: 'b2', status: 'failed' }),
      leaf({ id: 'live', title: 'Still going', branchId: 'b2', status: 'running' }),
    ]);
    await waitFor(() => expect(screen.getByText(/Needs you/i)).toBeInTheDocument());
    expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument();

    // Each appears exactly once, in the right list.
    expect(screen.getAllByText('Just broke')).toHaveLength(1);
    expect(screen.getAllByText('Left behind')).toHaveLength(1);
    expect(screen.getByText(/from .Build the server./)).toBeInTheDocument();
  });

  it('says a thing once, not in two lists at the same time', async () => {
    // It used to appear again in the inventory below, so one screen listed the same leaf twice.
    show([leaf({ id: 'f', title: 'Broken thing', branchId: 'b1', status: 'failed' })]);
    await waitFor(() => expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument());
    expect(screen.getAllByText('Broken thing')).toHaveLength(1);
  });

  it('labels work with who did it, not a persona id', async () => {
    show([leaf({ id: '1', status: 'succeeded', verified: true, personaId: 'p-builder' })], { 'p-builder': 'Builder' });
    await waitFor(() => expect(screen.getAllByText('Builder').length).toBeGreaterThan(0));
    expect(screen.queryByText('p-builder')).not.toBeInTheDocument();
  });

  it('does not count another project\'s work', async () => {
    /**
     * The reconciliation hazard in miniature: a leaf on a branch filed under a different tree must
     * not appear here, or every figure on the page describes the wrong project.
     */
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
    // The thing a board could not do. Scoped, there is no tree picker to get wrong.
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
    // Both states named, and no empty group taking up room for the four that have nothing in them.
    // Failed is not repeated here — it is above, with a review button. Verified has no action, so
    // the inventory is its only home.
    expect(screen.getByText(/Verified · 1/)).toBeInTheDocument();
    expect(screen.queryByText(/Blocked ·/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Broken')).toHaveLength(1);
    // And it is not in the inventory: a settled failure lives in the owed list.
    expect(screen.queryByText(/Failed ·/)).not.toBeInTheDocument();
  });
});

describe('dropping outstanding work', () => {
  it('lets you drop a thing the project is not going to do', async () => {
    /**
     * Without this the only way to clear an outstanding item was to delete the leaf, which throws
     * away the trace too. Dropping reuses `cancel` because `cancelled` already means "stopped
     * deliberately" everywhere — the board, the project context and the re-proposal list all
     * already refuse to resurrect it.
     */
    const { getByTitle } = show([leaf({ id: 'gone', title: 'Not worth it', branchId: 'b1', status: 'failed' })]);
    await waitFor(() => expect(screen.getByText(/Attempted, not delivered/i)).toBeInTheDocument());

    fireEvent.click(getByTitle(/Drop this/i));
    await waitFor(() => expect(groveApi.cancelLeaf).toHaveBeenCalledWith('gone'));
  });

  it('shows why it was not delivered, not just that it was not', async () => {
    // Whether a third attempt is worth making is unanswerable without knowing how the second ended.
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
    // Without a pushed branch there is nowhere to look, and the button would be a dead end.
    show([
      leaf({ id: 'withBranch', title: 'Has a branch', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' }),
      leaf({ id: 'without', title: 'No branch', branchId: 'b1', status: 'failed' }),
    ]);
    await waitFor(() => expect(screen.getByText('Has a branch')).toBeInTheDocument());
    expect(screen.getAllByTitle(/Look again/i)).toHaveLength(1);
  });

  it('shows the answer rather than acting on it silently', async () => {
    /**
     * The common outcome is "someone has to look", not a promotion — a leaf that promised no files
     * cannot be confirmed by a machine however much work is on its branch. Reporting that plainly
     * is the feature; quietly doing nothing would look broken.
     */
    vi.mocked(groveApi.recheckLeaf).mockResolvedValue({
      outcome: 'needs-a-look', reason: 'There is work on koala/abc, but this leaf promised no files.',
    });
    show([leaf({ id: 'l', title: 'Stranded', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' })]);
    await waitFor(() => expect(screen.getByTitle(/Look again/i)).toBeInTheDocument());

    fireEvent.click(screen.getByTitle(/Look again/i));
    await waitFor(() => expect(screen.getByText(/promised no files/)).toBeInTheDocument());
  });

  it('says so when the repository could not be read', async () => {
    // A recheck that failed must not read as a verdict of "still failed".
    vi.mocked(groveApi.recheckLeaf).mockRejectedValue({ response: { data: { error: 'Could not read the repository: 502' } } });
    show([leaf({ id: 'l', title: 'Stranded', branchId: 'b1', status: 'failed', outputBranch: 'koala/abc' })]);
    await waitFor(() => expect(screen.getByTitle(/Look again/i)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle(/Look again/i));
    await waitFor(() => expect(screen.getByText(/Could not read the repository/)).toBeInTheDocument());
  });
});
