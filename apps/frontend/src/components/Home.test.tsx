import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Home from './Home';
import type { Leaf } from './leaf-types';

const leaf = (over: Partial<Leaf>): Leaf => ({
  id: 'l', branchId: 'b1', title: 't', status: 'succeeded', updatedAt: '2026-08-01T00:00:00Z', ...over,
});

const TREE = { id: 't1', name: 'GitHub MCP Server', goal: 'Wrap the GitHub REST API' };
const BRANCHES = [
  { id: 'b1', title: 'Build the server', treeId: 't1' },
  { id: 'bx', title: 'Somebody else', treeId: 'other' },
];

const show = (leaves: Leaf[], handlers: { onStart?: (prompt: string) => void; onOpenLeaf?: (leaf: Leaf) => void } = {}) => render(
  <Home
    leaves={leaves}
    branches={BRANCHES}
    tree={TREE}
    onStart={handlers.onStart ?? (() => {})}
    onOpenLeaf={handlers.onOpenLeaf ?? (() => {})}
  />,
);

describe("a tree's home", () => {
  it('shows verified and claimed as separate figures, and a failure as work left', () => {
    show([
      leaf({ id: '1', verified: true }),
      leaf({ id: '2', verified: true }),
      leaf({ id: '3', status: 'claimed', claim: { evidence: 'e', at: 't' } }),
      leaf({ id: '4', status: 'failed' }),
    ]);
    expect(screen.getByText('2 verified')).toBeInTheDocument();
    expect(screen.getByText('1 claimed')).toBeInTheDocument();
    expect(screen.getByText('1 left')).toBeInTheDocument();
  });

  it('asks you about a claim the judge parked and about failures, and lists each once', () => {
    show([
      leaf({ id: 'parked', title: 'Parked claim', status: 'claimed', claim: { evidence: 'e', at: 't1' }, review: { verdict: 'concern', at: 't2' } }),
      leaf({ id: 'broken', title: 'Broken thing', status: 'failed', attempts: [{ attempt: 1, error: 'e', failedAt: '' }] }),
    ]);
    expect(screen.getByText(/Needs you · 2/)).toBeInTheDocument();
    expect(screen.getByText(/the judge could not settle the claim/)).toBeInTheDocument();
    expect(screen.getByText(/failed after 2 attempts/)).toBeInTheDocument();
    expect(screen.getAllByText('Broken thing')).toHaveLength(1);
  });

  it('does not count another tree\'s work', () => {
    show([
      leaf({ id: 'mine', title: 'Mine', verified: true }),
      leaf({ id: 'theirs', title: 'Theirs', branchId: 'bx', verified: true }),
    ]);
    expect(screen.getByText('Mine')).toBeInTheDocument();
    expect(screen.queryByText('Theirs')).not.toBeInTheDocument();
    expect(screen.getByText('1 verified')).toBeInTheDocument();
  });

  it('groups the rest of the work by state', () => {
    show([leaf({ id: 'v', title: 'Done', verified: true }), leaf({ id: 'p', title: 'Next', status: 'pending' })]);
    expect(screen.getByText(/Verified · 1/)).toBeInTheDocument();
    expect(screen.getByText(/To do · 1/)).toBeInTheDocument();
  });

  it('sends a request for more work on this tree, and opens a leaf', () => {
    const onStart = vi.fn();
    const onOpenLeaf = vi.fn();
    show([leaf({ id: 'v', title: 'Done', verified: true })], { onStart, onOpenLeaf });

    fireEvent.change(screen.getByPlaceholderText(/GitHub MCP Server/), { target: { value: 'add pagination' } });
    fireEvent.click(screen.getByRole('button', { name: /Start/ }));
    expect(onStart).toHaveBeenCalledWith('add pagination');

    fireEvent.click(screen.getByText('Done'));
    expect(onOpenLeaf).toHaveBeenCalledWith(expect.objectContaining({ id: 'v' }));
  });
});
