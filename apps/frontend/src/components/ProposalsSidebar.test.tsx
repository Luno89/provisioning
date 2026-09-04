import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import ProposalsSidebar, { type ProposalsSidebarProps } from './ProposalsSidebar.js';
import * as groveApi from '../api/grove.js';

vi.mock('../api/grove.js', async (orig) => ({
  ...(await orig<typeof groveApi>()),
  getTreeBoard: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});

function renderWithProviders(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function baseProps(overrides: Partial<ProposalsSidebarProps> = {}): ProposalsSidebarProps {
  return {
    isOpen: true,
    onToggle: vi.fn(),

    liveTrees: [],
    persistedTrees: undefined,
    onAcceptTree: vi.fn(),
    onDismissTree: vi.fn(),
    treeActionPending: false,

    liveSpecs: [],
    persistedSpecs: undefined,
    onAcceptSpec: vi.fn(),
    onDismissSpec: vi.fn(),
    specActionPending: false,

    liveEscalations: [],
    persistedEscalations: undefined,
    onAcceptEscalation: vi.fn(),
    onDenyEscalation: vi.fn(),
    escalationActionPending: false,

    liveSecretRequests: [],
    persistedSecretRequests: undefined,
    onSubmitSecret: vi.fn(),
    onDismissSecret: vi.fn(),
    secretActionPending: false,

    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();
});

describe('ProposalsSidebar', () => {
  it('renders nothing when closed', () => {
    const { container } = renderWithProviders(<ProposalsSidebar {...baseProps({ isOpen: false })} />);
    expect(container.querySelector('[data-testid="proposals-sidebar-panel"]')).toBeNull();
  });

  it('shows an empty state when nothing is pending', () => {
    renderWithProviders(<ProposalsSidebar {...baseProps()} />);
    expect(screen.getByText('Nothing pending')).toBeInTheDocument();
  });

  it('renders a pending tree proposal and calls accept/dismiss', () => {
    const onAcceptTree = vi.fn();
    const onDismissTree = vi.fn();
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveTrees: [{ id: 't-1', name: 'Odoo Stack', type: 'app', goal: 'Deploy odoo', proposedAt: '2026-09-01T00:00:00Z' }],
      onAcceptTree,
      onDismissTree,
    })} />);

    expect(screen.getByText('Odoo Stack')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Accept to Grove'));
    expect(onAcceptTree).toHaveBeenCalledWith('t-1');

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismissTree).toHaveBeenCalledWith('t-1');
  });

  it('renders a pending spec proposal and calls accept/dismiss', () => {
    const onAcceptSpec = vi.fn();
    const onDismissSpec = vi.fn();
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveSpecs: [{ id: 'mongo', spec: { id: 'mongo', image: 'mongo:7' }, proposedAt: '2026-09-01T00:00:00Z' }],
      onAcceptSpec,
      onDismissSpec,
    })} />);

    expect(screen.getByText('mongo')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Add to the catalogue'));
    expect(onAcceptSpec).toHaveBeenCalledWith('mongo');

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismissSpec).toHaveBeenCalledWith('mongo');
  });

  it('renders a pending escalation and calls approve/deny', () => {
    const onAcceptEscalation = vi.fn();
    const onDenyEscalation = vi.fn();
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveEscalations: [{
        id: 'esc-1', reason: 'Need cluster access', scope: 'cluster-admin',
        namespaces: ['monitoring'], status: 'pending', proposedAt: '2026-09-01T00:00:00Z',
      }],
      onAcceptEscalation,
      onDenyEscalation,
    })} />);

    expect(screen.getByText('Privilege Escalation Requested')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /approve escalation/i }));
    expect(onAcceptEscalation).toHaveBeenCalledWith('esc-1');

    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(onDenyEscalation).toHaveBeenCalledWith('esc-1');
  });

  it('renders a pending secret request and calls submit/dismiss', () => {
    const onSubmitSecret = vi.fn();
    const onDismissSecret = vi.fn();
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveSecretRequests: [{
        id: 'sec-1', key: 'GITHUB_TOKEN', description: 'Needed for module sync',
        status: 'pending', requestedAt: '2026-09-01T00:00:00Z',
      }],
      onSubmitSecret,
      onDismissSecret,
    })} />);

    expect(screen.getByText('GITHUB_TOKEN')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismissSecret).toHaveBeenCalledWith('sec-1');

    fireEvent.change(screen.getByPlaceholderText('Enter GITHUB_TOKEN...'), { target: { value: 'ghp_abc' } });
    fireEvent.click(screen.getByRole('button', { name: /save to vault/i }));
    expect(onSubmitSecret).toHaveBeenCalledWith('sec-1', 'ghp_abc');
  });

  it('shows a progress indicator for an accepted tree that is still settling', async () => {
    vi.mocked(groveApi.getTreeBoard).mockResolvedValue({
      tree: { id: 't-1' } as any,
      rollup: {
        counts: { proposed: 0, blocked: 0, running: 1, claimed: 0, verified: 2, failed: 0 },
        outstanding: 1,
        tokens: 0,
        retried: 0,
        branches: 1,
      },
    });

    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveTrees: [{ id: 't-1', name: 'Odoo Stack', type: 'app', goal: 'Deploy odoo', proposedAt: '2026-09-01T00:00:00Z', treeId: 'tree-1' }],
    })} />);

    expect(screen.getByText('In Progress')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/2 verified/)).toBeInTheDocument());
    expect(screen.getByText(/1 running/)).toBeInTheDocument();
  });

  it('drops a fully-settled accepted tree from the sidebar', async () => {
    vi.mocked(groveApi.getTreeBoard).mockResolvedValue({
      tree: { id: 't-1' } as any,
      rollup: {
        counts: { proposed: 0, blocked: 0, running: 0, claimed: 0, verified: 3, failed: 0 },
        outstanding: 0,
        tokens: 0,
        retried: 0,
        branches: 1,
      },
    });

    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveTrees: [{ id: 't-1', name: 'Odoo Stack', type: 'app', goal: 'Deploy odoo', proposedAt: '2026-09-01T00:00:00Z', treeId: 'tree-1' }],
    })} />);

    await waitFor(() => expect(groveApi.getTreeBoard).toHaveBeenCalledWith('tree-1'));
    await waitFor(() => expect(screen.queryByText('Odoo Stack')).not.toBeInTheDocument());
  });

  it('does not show an accepted spec (acceptedAt set) as pending', () => {
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveSpecs: [{ id: 'mongo', spec: { id: 'mongo', image: 'mongo:7' }, proposedAt: '2026-09-01T00:00:00Z', acceptedAt: '2026-09-01T00:05:00Z' }],
    })} />);

    expect(screen.queryByText('Add to the catalogue')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing pending')).toBeInTheDocument();
  });

  it('does not show a dismissed tree as pending', () => {
    renderWithProviders(<ProposalsSidebar {...baseProps({
      liveTrees: [{ id: 't-1', name: 'Odoo Stack', type: 'app', goal: 'Deploy odoo', proposedAt: '2026-09-01T00:00:00Z', dismissedAt: '2026-09-01T00:05:00Z' }],
    })} />);

    expect(screen.queryByText('Odoo Stack')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing pending')).toBeInTheDocument();
  });
});
