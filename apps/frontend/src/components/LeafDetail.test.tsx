import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import LeafDetail from './LeafDetail';
import type { Leaf } from './leaf-types';
import * as documentsApi from '../api/documents';

vi.mock('../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof documentsApi>()),
  readDocument: vi.fn(),
}));

const readDocument = vi.mocked(documentsApi.readDocument);

const claimed: Leaf = {
  id: 'l1', branchId: 'b1', title: 'Health endpoint', status: 'claimed', updatedAt: 'now',
  claim: { evidence: 'curl answered 200', at: 'now', commit: 'c0ffee1234567890', files: ['src/health.ts', 'notes/why.md'] },
};

const renderLeaf = (leaf: Leaf, treeId?: string) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><LeafDetail leaf={leaf} treeId={treeId} /></QueryClientProvider>);
};

beforeEach(() => { vi.clearAllMocks(); });

describe('a leaf\'s documents on its page', () => {
  it('lists what its branch changed and opens one at the claimed commit', async () => {
    readDocument.mockResolvedValue({ workspace: 'tree-t1', path: 'notes/why.md', owner: 'koala-u1', repo: 'tree-t1', ref: 'c0ffee1234567890', content: '# Why\n\nBecause.' });
    renderLeaf(claimed, 't1');

    expect(screen.getByRole('button', { name: /src\/health\.ts/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /notes\/why\.md/ }));

    expect(await screen.findByText('Because.')).toBeInTheDocument();
    expect(readDocument).toHaveBeenCalledWith({ workspace: 'tree-t1', path: 'notes/why.md', at: 'c0ffee1234567890' });
    fireEvent.click(screen.getByRole('button', { name: 'Close document' }));
    expect(screen.queryByText('Because.')).not.toBeInTheDocument();
  });

  it('shows no documents for a leaf that has not claimed', () => {
    const { claim: _claim, ...unclaimed } = claimed;
    renderLeaf({ ...unclaimed, status: 'running' }, 't1');

    expect(screen.queryByText('Documents')).not.toBeInTheDocument();
  });
});
