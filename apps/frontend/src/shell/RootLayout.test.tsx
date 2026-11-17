import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../features/infrastructure/api/clusters';
import * as deploymentsApi from '../features/infrastructure/api/deployments';
import * as credentialsApi from '../features/infrastructure/api/credentials';
import * as authApi from '../features/platform/api';
import * as identityApi from '../features/instances/api/identity';
import * as instancesApi from '../features/instances/api/instances';

vi.mock('../features/infrastructure/api/clusters', async (importOriginal) => ({
  ...(await importOriginal<typeof clustersApi>()),
  listClusters: vi.fn(),
}));
vi.mock('../features/infrastructure/api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  listDeployments: vi.fn(),
}));
vi.mock('../features/infrastructure/api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof credentialsApi>()),
  listProviders: vi.fn(),
}));
vi.mock('../features/platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof authApi>()),
  getMe: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../features/instances/api/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof identityApi>()),
  getMyInstance: vi.fn(),
}));
vi.mock('../features/instances/api/instances', async (importOriginal) => ({
  ...(await importOriginal<typeof instancesApi>()),
  useMySetup: vi.fn(() => ({ data: null, isPending: false })),
  usePoolOffer: vi.fn(() => ({ data: { offered: false }, isPending: false })),
}));

const show = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
};

describe('where a signed-in person lands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clustersApi.listClusters).mockResolvedValue([]);
    vi.mocked(deploymentsApi.listDeployments).mockResolvedValue([]);
    vi.mocked(credentialsApi.listProviders).mockResolvedValue([]);
    vi.mocked(authApi.getMe).mockResolvedValue({ id: 'u1', email: 'u@example.com' });
  });

  it('root\'s page never reads clusters, deployments or cloud providers', async () => {
    vi.mocked(identityApi.getMyInstance).mockResolvedValue({ instance: null, servesTenants: false });
    show();
    expect((await screen.findAllByRole('button', { name: /Sign out/ })).length).toBeGreaterThan(0);
    expect(screen.queryByText('Infrastructure')).toBeNull();
    expect(clustersApi.listClusters).not.toHaveBeenCalled();
    expect(deploymentsApi.listDeployments).not.toHaveBeenCalled();
    expect(credentialsApi.listProviders).not.toHaveBeenCalled();
  });

  it('a missing identity route is an error shown, not "no instance", and reads nothing of a tenant', async () => {
    vi.mocked(identityApi.getMyInstance).mockRejectedValue(Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'Cannot GET /api/identity/instance' } } }));
    show();
    expect(await screen.findByText(/Koala could not tell whether this server holds your work/)).toBeInTheDocument();
    expect(screen.getByText(/Cannot GET \/api\/identity\/instance/)).toBeInTheDocument();
    expect(screen.queryByText('Infrastructure')).toBeNull();
    expect(clustersApi.listClusters).not.toHaveBeenCalled();
  });
});
