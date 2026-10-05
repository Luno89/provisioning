import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocumentPanel from './DocumentPanel';
import * as documentsApi from '../api/documents';

vi.mock('../api/documents', async (importOriginal) => ({
  ...(await importOriginal<typeof documentsApi>()),
  readDocument: vi.fn(),
}));

const readDocument = vi.mocked(documentsApi.readDocument);
const file = { kind: 'file' as const, workspace: 'conversation-c1', path: 'research/r1/findings.md' };

const renderPanel = (onClose = () => undefined, address: { workspace: string; path: string; at?: string } = file) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><DocumentPanel file={address} onClose={onClose} /></QueryClientProvider>);
};

beforeEach(() => { vi.clearAllMocks(); });

describe('DocumentPanel', () => {
  it('shows the saved file and where it is kept', async () => {
    readDocument.mockResolvedValue({ workspace: 'conversation-c1', path: 'research/r1/findings.md', owner: 'koala-u1', repo: 'research-c1', ref: 'main', content: '# Findings\n\nPort 5432.' });
    renderPanel();

    expect(await screen.findByText('Port 5432.')).toBeInTheDocument();
    expect(screen.getByText('in koala-u1/research-c1')).toBeInTheDocument();
    expect(readDocument).toHaveBeenCalledWith(file);
  });

  it('reads a leaf\'s file at the commit it claimed, and says when that commit is gone and main is shown', async () => {
    const leafFile = { workspace: 'tree-t1', path: 'src/health.ts', at: 'c0ffee1234567890' };
    readDocument.mockResolvedValueOnce({ workspace: 'tree-t1', path: 'src/health.ts', owner: 'koala-u1', repo: 'tree-t1', ref: 'c0ffee1234567890', content: 'on the branch' });
    const first = renderPanel(undefined, leafFile);

    expect(await screen.findByText('on the branch')).toBeInTheDocument();
    expect(screen.getByText('in koala-u1/tree-t1 at c0ffee123456')).toBeInTheDocument();
    expect(readDocument).toHaveBeenCalledWith(leafFile);
    first.unmount();

    readDocument.mockResolvedValueOnce({ workspace: 'tree-t1', path: 'src/health.ts', owner: 'koala-u1', repo: 'tree-t1', ref: 'main', content: 'merged' });
    renderPanel(undefined, leafFile);
    expect(await screen.findByText('merged')).toBeInTheDocument();
    expect(screen.getByText(/its commit is gone, so this is main/)).toBeInTheDocument();
  });

  it('says why when the file cannot be opened, and closes', async () => {
    readDocument.mockRejectedValue({ response: { data: { error: 'research/r1/findings.md has not been saved to research-c1' } } });
    const onClose = vi.fn();
    renderPanel(onClose);

    expect(await screen.findByText('research/r1/findings.md has not been saved to research-c1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close document' }));
    expect(onClose).toHaveBeenCalled();
  });
});
