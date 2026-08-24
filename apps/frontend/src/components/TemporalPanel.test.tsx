import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TemporalPanel from './TemporalPanel';
import * as temporalApi from '../api/temporal';

/**
 * The panel had no test at all — it was one of nine extracted screens with none (R25).
 *
 * Mocked at the api module rather than at axios: `vi.mock('axios')` cannot reach the instance
 * `api/client` builds with `axios.create()`, so a URL-matching stub silently never fires.
 */
vi.mock('../api/temporal', async (importOriginal) => ({
  ...(await importOriginal<typeof temporalApi>()),
  getTemporalStatus: vi.fn(),
  getWorkflowCount: vi.fn(),
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
}));

const COUNTS = { total: 2, running: 1, completed: 1, failed: 0, timedOut: 0 };

const renderPanel = (
  workflows: temporalApi.WorkflowSummary[],
  status: temporalApi.TemporalStatus = { connected: true, serverVersion: '1.25.0' },
) => {
  vi.mocked(temporalApi.getTemporalStatus).mockResolvedValue(status);
  vi.mocked(temporalApi.getWorkflowCount).mockResolvedValue(COUNTS);
  vi.mocked(temporalApi.listWorkflows).mockResolvedValue(workflows);
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

  /**
   * Temporal is OPTIONAL — the backend starts and falls back to DB polling when it is unreachable.
   * So "not connected" is an ordinary state this panel has to render, not an error case.
   */
  it('renders when Temporal is not connected', async () => {
    renderPanel([], { connected: false });
    await waitFor(() => expect(vi.mocked(temporalApi.getTemporalStatus)).toHaveBeenCalled());
    // The point is that it does not throw on a missing serverVersion.
    expect(screen.queryByText(/app-deploy/)).toBeNull();
  });

  it('survives a status with no serverVersion', async () => {
    renderPanel([{ workflowId: 'w1', status: 'COMPLETED' }], { connected: true });
    await waitFor(() => expect(screen.getByText(/w1/)).toBeDefined());
  });

  /** An unknown status must not blank the row — the map is keyed by string, not exhaustive. */
  it('renders a workflow whose status is not in the colour map', async () => {
    renderPanel([{ workflowId: 'odd-one', status: 'CONTINUED_AS_NEW' }]);
    await waitFor(() => expect(screen.getByText(/odd-one/)).toBeDefined());
  });
});
