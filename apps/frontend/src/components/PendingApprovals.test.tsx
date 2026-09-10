import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PendingApprovals } from './PendingApprovals';
import * as approvalsApi from '../api/pending-approvals';

vi.mock('../api/pending-approvals', async (importOriginal) => ({
  ...(await importOriginal<typeof approvalsApi>()),
  listPendingApprovals: vi.fn(),
  decideApproval: vi.fn(),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingApprovals />
    </QueryClientProvider>,
  );
}

describe('PendingApprovals', () => {
  it('renders nothing when there is nothing pending', async () => {
    vi.mocked(approvalsApi.listPendingApprovals).mockResolvedValue([]);
    const { container } = renderPanel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe('');
  });

  it('shows the command a leaf wants to run and lets the user approve it', async () => {
    vi.mocked(approvalsApi.listPendingApprovals).mockResolvedValue([
      { id: 'a-1', leafId: 'leaf-1', command: 'rm -rf build/', status: 'pending', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    vi.mocked(approvalsApi.decideApproval).mockResolvedValue({ success: true });

    renderPanel();

    expect(await screen.findByText('rm -rf build/')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(approvalsApi.decideApproval).toHaveBeenCalledWith('a-1', 'approved'));
  });

  it('lets the user deny a command', async () => {
    vi.mocked(approvalsApi.listPendingApprovals).mockResolvedValue([
      { id: 'a-1', leafId: 'leaf-1', command: 'curl evil.example', status: 'pending', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    vi.mocked(approvalsApi.decideApproval).mockResolvedValue({ success: true });

    renderPanel();

    await screen.findByText('curl evil.example');
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));

    await waitFor(() => expect(approvalsApi.decideApproval).toHaveBeenCalledWith('a-1', 'denied'));
  });

  it('renders one card per pending approval', async () => {
    vi.mocked(approvalsApi.listPendingApprovals).mockResolvedValue([
      { id: 'a-1', leafId: 'leaf-1', command: 'echo a', status: 'pending', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a-2', leafId: 'leaf-2', command: 'echo b', status: 'pending', createdAt: '2026-01-01T00:00:01Z' },
    ]);

    renderPanel();

    expect(await screen.findByText('echo a')).toBeInTheDocument();
    expect(screen.getByText('echo b')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /approve/i })).toHaveLength(2);
  });
});
