import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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

  it('puts what is owed above what is done, and says it once', async () => {
    /**
     * A failure buried under twenty green rows is a failure nobody acts on — so it goes to the top,
     * with its button. And exactly once: it used to appear again in the inventory below, so one
     * screen listed the same leaf twice.
     */
    show([leaf({ id: 'f', title: 'Broken thing', status: 'failed' })]);
    await waitFor(() => expect(screen.getByText(/Needs you/i)).toBeInTheDocument());
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
  });
});
