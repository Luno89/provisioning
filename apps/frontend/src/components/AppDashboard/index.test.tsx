import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDashboard from './index';
import * as deploymentsApi from '../../api/deployments';
import * as modelsApi from '../../api/models';
import type { Deployment } from '../../types/deployment';

vi.mock('../../api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  useDeploymentPods: vi.fn(() => ({ pods: [], namespace: 'odoo', checkedAt: Date.now() })),
  useHelmStatus: vi.fn(() => ({ data: undefined })),
  useDiagnostics: vi.fn(() => ({ data: undefined })),
  useAvailableModules: vi.fn(() => ({ data: [], isLoading: false })),
  useResourcePlan: vi.fn(() => ({ data: undefined })),
  useInitialLogs: vi.fn(() => ({ data: undefined })),
}));
vi.mock('../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
}));

const useHelmStatus = vi.mocked(deploymentsApi.useHelmStatus);
const useDiagnostics = vi.mocked(deploymentsApi.useDiagnostics);
const useInitialLogs = vi.mocked(deploymentsApi.useInitialLogs);

const deployment = (over: Partial<Deployment> = {}): Deployment => ({
  id: 'd1', name: 'odoo-prod', appType: 'odoo', clusterId: 'c1', status: 'running',
  strategy: 'native', ...over,
});

const setup = (d: Deployment = deployment(), initialTab: Parameters<typeof AppDashboard>[0]['initialTab'] = 'general') => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDashboard
        target={{ type: 'app', id: d.id }}
        deployment={d}
        deployments={[d]}
        clusters={[{ id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy' }]}
        cluster={null}
        initialTab={initialTab}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
  return { onClose, user: userEvent.setup() };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the dashboard', () => {
  it('names the deployment it is showing', () => {
    setup();
    expect(screen.getByText(/odoo-prod/)).toBeDefined();
  });

  it('closes through its callback rather than App\'s setter', () => {
    const { onClose } = setup();
    screen.getByLabelText('Close dashboard').click();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the tabs', () => {
  it('shows Helm output when that tab is opened', async () => {
    useHelmStatus.mockReturnValue({ data: { content: 'REVISION: 3' } } as never);
    const { user } = setup();
    await user.click(screen.getByText('Helm Status'));
    expect(await screen.findByText(/REVISION: 3/)).toBeDefined();
  });

  it('shows diagnostics when that tab is opened', async () => {
    useDiagnostics.mockReturnValue({ data: { content: 'kube-system pod running' } } as never);
    const { user } = setup();
    await user.click(screen.getByText('Diagnostics'));
    await waitFor(() => {
      expect(document.body.textContent).toContain('kube-system pod running');
    });
  });

  it('fetches each tab\'s data only while that tab is open', () => {
    setup(deployment(), 'general');
    expect(useHelmStatus).toHaveBeenCalledWith('d1', false);
    expect(useDiagnostics).toHaveBeenCalledWith('d1', false);
  });

  it('opens on the tab it was told to', () => {
    setup(deployment(), 'provision');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe('a failed deployment', () => {
  it('fetches the provisioning log on the General tab, where the reason actually is', () => {
    setup(deployment({ status: 'failed' }), 'general');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('does not fetch it for a healthy one on the same tab', () => {
    setup(deployment({ status: 'running' }), 'general');
    expect(useInitialLogs).toHaveBeenCalledWith(expect.anything(), false);
  });
});
