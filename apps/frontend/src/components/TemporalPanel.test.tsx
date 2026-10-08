import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useShellStore } from '../stores/shell';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TemporalPanel from './TemporalPanel';
import * as temporalApi from '../api/temporal';

vi.mock('../api/temporal', async (importOriginal) => ({
  ...(await importOriginal<typeof temporalApi>()),
  getTemporalStatus: vi.fn(),
  getWorkflowCount: vi.fn(),
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
}));

const COUNTS = { total: 2, running: 1, completed: 1, failed: 0, timedOut: 0 };

const renderPanel = (
  workflows: temporalApi.WorkflowSummary[],
  status: temporalApi.TemporalStatus = { connected: true, serverVersion: '1.25.0' },
  access: { canSeeAll?: boolean } = {},
) => {
  vi.mocked(temporalApi.getTemporalStatus).mockResolvedValue(status);
  vi.mocked(temporalApi.getWorkflowCount).mockResolvedValue(COUNTS);
  vi.mocked(temporalApi.listWorkflows).mockImplementation(async (_size, scope) => ({ workflows, all: scope === 'all', canSeeAll: access.canSeeAll === true }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TemporalPanel />
    </QueryClientProvider>,
  );
};

describe('TemporalPanel', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('lists the workflows it was given', async () => {
    renderPanel([
      { workflowId: 'app-deploy-Wordpress-123', type: 'executeDeployAppWorkflow', status: 'RUNNING' },
      { workflowId: 'cluster-provision-dev-456', type: 'ClusterProvisionWorkflow', status: 'COMPLETED' },
    ]);
    await waitFor(() => expect(screen.getByText(/app-deploy-Wordpress-123/)).toBeDefined());
    expect(screen.getByText(/cluster-provision-dev-456/)).toBeDefined();
  });

  it('renders when Temporal is not connected', async () => {
    renderPanel([], { connected: false });
    await waitFor(() => expect(vi.mocked(temporalApi.getTemporalStatus)).toHaveBeenCalled());
    expect(screen.queryByText(/app-deploy/)).toBeNull();
  });

  it('survives a status with no serverVersion', async () => {
    renderPanel([{ workflowId: 'w1', status: 'COMPLETED' }], { connected: true });
    await waitFor(() => expect(screen.getByText(/w1/)).toBeDefined());
  });

  it('renders a workflow whose status is not in the colour map', async () => {
    renderPanel([{ workflowId: 'odd-one', status: 'CONTINUED_AS_NEW' }]);
    await waitFor(() => expect(screen.getByText(/odd-one/)).toBeDefined());
  });

  it('offers someone who may see everything a switch between their own and everything, and asks for each', async () => {
    renderPanel([{ workflowId: 'w1', status: 'RUNNING', owner: 'a' }], undefined, { canSeeAll: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Everything' }));
    await waitFor(() => expect(temporalApi.listWorkflows).toHaveBeenCalledWith(50, 'all'));
    expect(temporalApi.getWorkflowCount).toHaveBeenCalledWith('all');
    expect(screen.getByRole('button', { name: 'Everything' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('offers no switch to someone who sees only their own', async () => {
    renderPanel([{ workflowId: 'w1', status: 'RUNNING', owner: 'b' }]);
    await screen.findByText('w1');
    expect(screen.queryByRole('group', { name: 'Whose workflows' })).toBeNull();
  });

  describe('cancelling a running workflow', () => {
    const running = (owner: string) => ({ workflowId: 'run-1', type: 'AgentRunWorkflow', status: 'RUNNING', runId: 'r1', taskQueue: 'engine', owner });
    const open = async (owner: string, access: { canSeeAll?: boolean } = {}) => {
      vi.mocked(temporalApi.getWorkflow).mockResolvedValue(running(owner));
      renderPanel([running(owner)], undefined, access);
      fireEvent.click(await screen.findByText('run-1'));
    };

    it('asks first, then cancels the viewer\'s own workflow', async () => {
      useShellStore.setState({ user: { id: 'bo', email: 'bo@example.com' } as never });
      vi.mocked(temporalApi.cancelWorkflow).mockResolvedValue(undefined);
      await open('bo');

      expect(await screen.findByText('you')).toBeDefined();
      fireEvent.click(await screen.findByRole('button', { name: /Cancel workflow/ }));
      expect(temporalApi.cancelWorkflow).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /Yes, cancel it/ }));

      await waitFor(() => expect(temporalApi.cancelWorkflow).toHaveBeenCalledWith('run-1'));
      expect(await screen.findByText(/Cancel requested/)).toBeDefined();
    });

    it('lets them change their mind', async () => {
      useShellStore.setState({ user: { id: 'bo', email: 'bo@example.com' } as never });
      await open('bo');
      fireEvent.click(await screen.findByRole('button', { name: /Cancel workflow/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Keep it running' }));
      expect(screen.getByRole('button', { name: /Cancel workflow/ })).toBeDefined();
      expect(temporalApi.cancelWorkflow).not.toHaveBeenCalled();
    });

    it('lets someone who may see everything cancel another\'s, and nobody else', async () => {
      useShellStore.setState({ user: { id: 'ada', email: 'ada@example.com', isAdmin: true } as never });
      await open('platform', { canSeeAll: true });
      expect(await screen.findByText('the platform')).toBeDefined();
      expect(await screen.findByRole('button', { name: /Cancel workflow/ })).toBeDefined();
    });

    it('offers no cancel on a workflow that is not the viewer\'s', async () => {
      useShellStore.setState({ user: { id: 'cy', email: 'cy@example.com' } as never });
      await open('bo');
      await screen.findByText('engine');
      expect(screen.queryByRole('button', { name: /Cancel workflow/ })).toBeNull();
    });
  });
});
