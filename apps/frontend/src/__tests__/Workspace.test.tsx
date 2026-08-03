import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import Workspace from '../components/Workspace';

/**
 * Wiring tests for the Koala surface.
 *
 * These exist because every bug found in this UI so far was a WIRING bug that passing unit tests
 * missed — stripProposalBlock written and never called, the transcript discarded on a click, the
 * proposal panel acting on parsed text instead of real records. jsdom cannot see layout, so it
 * will never catch a stray scrollbar; it catches exactly the class of thing that has actually
 * been breaking.
 */
vi.mock('axios');
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

const renderWorkspace = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Workspace apiBase="/api" />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAxios.get.mockResolvedValue({ data: [] });
  mockedAxios.post.mockResolvedValue({ data: {} });
  mockedAxios.delete.mockResolvedValue({ data: {} });
});

describe('the tree', () => {
  it('renders a branch with its leaves nested under it', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [leaf(), leaf({ id: 'leaf-2', title: 'Add metrics', parentLeafId: 'leaf-1', depth: 1 })],
    });
    renderWorkspace();
    await waitFor(() => expect(tree().getAllByText('Add rate limiting').length).toBeGreaterThan(0));
    expect(tree().getByText('Add metrics')).toBeInTheDocument();
  });

  it('shows an empty branch, so a fresh conversation has somewhere to live', async () => {
    renderWorkspace();
    // Branches are derived from leaves; without the active one included, a new chat would have no
    // node in the tree at all.
    await waitFor(() => expect(screen.getByText('New branch')).toBeInTheDocument());
  });
});

describe('selecting a leaf', () => {
  it('opens the detail view for it', async () => {
    mockedAxios.get.mockResolvedValue({ data: [leaf({ body: 'Token bucket per API key.' })] });
    renderWorkspace();
    // Last match is the leaf row; the first is the branch heading named after it.
    await waitFor(() => expect(tree().getAllByText('Add rate limiting').length).toBe(2));

    fireEvent.click(tree().getAllByText('Add rate limiting')[1]!);
    // The body only appears in the detail pane, so its presence proves the switch happened.
    await waitFor(() => expect(detail().getByText('Token bucket per API key.')).toBeInTheDocument());
  });

  it('shows failed attempts, which is the whole reason to open a broken leaf', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [leaf({ status: 'failed', attempts: [{ attempt: 0, error: 'tests did not compile', failedAt: 'x' }] })],
    });
    renderWorkspace();
    await waitFor(() => expect(tree().getAllByText('Add rate limiting').length).toBe(2));
    fireEvent.click(tree().getAllByText('Add rate limiting')[1]!);
    await waitFor(() => expect(detail().getByText('tests did not compile')).toBeInTheDocument());
  });
});

describe('proposals', () => {
  it('offers accept and reject for a proposed leaf', async () => {
    mockedAxios.get.mockResolvedValue({ data: [leaf({ status: 'proposed' })] });
    renderWorkspace();
    await openBranch('Add rate limiting');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    expect(detail().getByTitle('Reject')).toBeInTheDocument();
  });

  it('accepting posts to the accept endpoint with the real leaf id', async () => {
    // The panel used to be built from parsed model text; it must act on the actual record, since
    // the server's extractor is what created it and the two can differ.
    mockedAxios.get.mockResolvedValue({ data: [leaf({ id: 'real-id', status: 'proposed' })] });
    renderWorkspace();
    await openBranch('Add rate limiting');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());

    fireEvent.click(detail().getByTitle('Accept — starts the work'));
    await waitFor(() =>
      expect(mockedAxios.post).toHaveBeenCalledWith('/api/leaves/real-id/accept', {}, expect.anything()),
    );
  });

  it('offers accept-all only when more than one is proposed', async () => {
    mockedAxios.get.mockResolvedValue({ data: [leaf({ status: 'proposed' })] });
    renderWorkspace();
    await openBranch('Add rate limiting');
    await waitFor(() => expect(detail().getByTitle('Accept — starts the work')).toBeInTheDocument());
    // One proposal: accept-all would be a second button doing the same thing.
    expect(detail().queryByText('Accept all')).not.toBeInTheDocument();
  });

  it('shows accept-all for several, and accepts each one', async () => {
    mockedAxios.get.mockResolvedValue({
      data: [leaf({ status: 'proposed' }), leaf({ id: 'leaf-2', title: 'Add metrics', status: 'proposed' })],
    });
    renderWorkspace();
    await openBranch('Add rate limiting');
    await waitFor(() => expect(detail().getByText('Accept all')).toBeInTheDocument());

    fireEvent.click(detail().getByText('Accept all'));
    await waitFor(() => expect(mockedAxios.post).toHaveBeenCalledTimes(2));
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/leaves/leaf-1/accept', {}, expect.anything());
    expect(mockedAxios.post).toHaveBeenCalledWith('/api/leaves/leaf-2/accept', {}, expect.anything());
  });

  it('does not show proposed leaves as ordinary work in the tree', async () => {
    // A proposal is not work yet; it must be visually distinct from an accepted leaf.
    mockedAxios.get.mockResolvedValue({ data: [leaf({ status: 'proposed' })] });
    renderWorkspace();
    await waitFor(() => expect(screen.getAllByTitle('proposed').length).toBeGreaterThan(0));
  });
});
