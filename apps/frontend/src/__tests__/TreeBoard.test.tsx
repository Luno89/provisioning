import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import axios from 'axios';
import TreeBoard from '../components/TreeBoard';

/**
 * Wiring tests for the project board.
 *
 * Same reasoning as Workspace.test.tsx: jsdom cannot see layout, and every bug in this UI so far
 * has been a wiring bug. The thing most worth pinning here is that a CLAIM never renders as
 * verified — that distinction is the board's whole argument, and it is one careless `succeeded`
 * check away from being lost.
 */
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const board = (over: Record<string, unknown> = {}) => ({
  tree: { id: 't1', name: 'GitHub MCP Server', type: 'api-service', goal: 'Wrap the GitHub REST API' },
  rollup: {
    counts: { proposed: 1, blocked: 1, running: 0, claimed: 1, verified: 2, failed: 0 },
    outstanding: 2, tokens: 42_000, retried: 1, branches: 2,
  },
  changed: 3,
  repos: [{ id: 'p1', name: 'mcp-github-server', owner: 'koala', repo: 'mcp-github-server' }],
  branches: [
    { id: 'b1', title: 'Build the server', updatedAt: '2026-01-01T00:00:00Z' },
    { id: 'b2', title: 'Fix the defects', updatedAt: '2026-01-02T00:00:00Z' },
  ],
  leaves: [
    { id: 'l1', branchId: 'b1', title: 'MCP stdio transport', status: 'succeeded', column: 'verified',
      personaId: 'p-builder', verified: true, merged: true, tokens: 24_000, attempts: 1, waitingOn: [], updatedAt: '' },
    { id: 'l2', branchId: 'b1', title: 'Define MCP tools', status: 'succeeded', column: 'claimed',
      personaId: 'p-builder', verified: false, tokens: 31_000, attempts: 2, waitingOn: [], updatedAt: '' },
    { id: 'l3', branchId: 'b2', title: 'Add tests', status: 'pending', column: 'blocked',
      personaId: 'p-builder', tokens: 0, attempts: 0,
      waitingOn: [{ id: 'l1', title: 'MCP stdio transport' }], updatedAt: '' },
    { id: 'l4', branchId: 'b2', title: 'Write the README', status: 'proposed', column: 'proposed',
      tokens: 0, attempts: 0, waitingOn: [], updatedAt: '' },
  ],
  ...over,
});

const draw = (over: Record<string, unknown> = {}) => {
  mockedAxios.get.mockImplementation((url: string) => {
    if (url.includes('/board')) return Promise.resolve({ data: board(over) });
    if (url.includes('/trace')) return Promise.resolve({ data: { steps: [], totalSteps: 0, tokensUsed: 0, missing: true } });
    return Promise.resolve({ data: {} });
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TreeBoard apiBase="/api" treeId="t1" personaNames={{ 'p-builder': 'Builder' }} onBack={() => {}} />
    </QueryClientProvider>,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('the project board', () => {
  it('shows verified and claimed as separate figures', async () => {
    /**
     * The board's entire argument. `verified` means a check ran; `succeeded` means the agent said
     * so. A single "2 done" would launder the claim into a fact at the one place a person looks.
     */
    await draw();
    expect(await screen.findByText(/2 verified/)).toBeInTheDocument();
    expect(screen.getByText(/1 claimed/)).toBeInTheDocument();
    // And never a combined total.
    expect(screen.queryByText(/3 done/i)).not.toBeInTheDocument();
  });

  it('marks an unchecked success on its own card', async () => {
    await draw();
    await screen.findByText('Define MCP tools');
    expect(screen.getByText('unchecked')).toBeInTheDocument();
  });

  it('names what a blocked leaf is waiting on', async () => {
    // "Blocked" is not actionable; "waits on the transport leaf" is.
    await draw();
    expect(await screen.findByText(/waits on MCP stdio transport/)).toBeInTheDocument();
  });

  it('reports what moved while nobody was watching', async () => {
    // This board changes overnight, so a static snapshot would be indistinguishable from a dead one.
    await draw();
    expect(await screen.findByText(/3 changes since you last looked/)).toBeInTheDocument();
  });

  it('says nothing changed when there is nothing to report', async () => {
    await draw({ changed: 0 });
    await screen.findByText('MCP stdio transport');
    expect(screen.queryByText(/since you last looked/)).not.toBeInTheDocument();
  });

  it('counts failures as work still left', async () => {
    await draw({
      rollup: { counts: { proposed: 0, blocked: 0, running: 0, claimed: 0, verified: 1, failed: 1 }, outstanding: 1, tokens: 0, retried: 0, branches: 1 },
    });
    expect(await screen.findByText(/1 left/)).toBeInTheDocument();
  });

  it('labels cards with who did the work, not a persona id', async () => {
    await draw();
    expect((await screen.findAllByText('Builder')).length).toBeGreaterThan(0);
    expect(screen.queryByText('p-builder')).not.toBeInTheDocument();
  });

  it('opens the trace when a card is clicked', async () => {
    // The drill-in is the point of the board; a card that does not open is a decorative card.
    await draw();
    fireEvent.click(await screen.findByText('MCP stdio transport'));
    await waitFor(() => {
      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.stringContaining('/leaves/l1/trace'),
        expect.anything(),
      );
    });
  });

  it('offers review and retry on a failed leaf, and neither on a healthy one', async () => {
    /**
     * Both, not just retry. Retrying cannot fix an environmental cause, and every real cause found
     * in this system so far has been environmental — offering only retry would make the useless
     * action the obvious one.
     */
    await draw({
      leaves: [{ id: 'lf', branchId: 'b1', title: 'Broken leaf', status: 'failed', column: 'failed',
        tokens: 900, attempts: 3, waitingOn: [], updatedAt: '' }],
    });
    fireEvent.click(await screen.findByText('Broken leaf'));
    expect(await screen.findByText(/Review the failure/)).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
    // And it says which of the two is the better bet by now.
    expect(screen.getByText(/Already tried 3 times/)).toBeInTheDocument();
  });

  it('does not offer a retry for work that did not fail', async () => {
    await draw();
    fireEvent.click(await screen.findByText('MCP stdio transport'));
    await screen.findByText(/has not run yet|turns/);
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('distinguishes a leaf that never ran from one whose record was lost', async () => {
    await draw();
    fireEvent.click(await screen.findByText('Write the README'));
    expect(await screen.findByText(/has not run yet/)).toBeInTheDocument();
  });
});
