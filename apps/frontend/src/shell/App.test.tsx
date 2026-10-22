import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as authApi from '../features/platform/api';
import * as credentialsApi from '../api/credentials';

vi.mock('../api/clusters', async (importOriginal) => ({
  ...(await importOriginal<typeof clustersApi>()),
  listClusters: vi.fn(),
}));
vi.mock('../api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  listDeployments: vi.fn(),
}));
vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof credentialsApi>()),
  listProviders: vi.fn(),
}));
vi.mock('../features/platform/api', async (importOriginal) => ({
  ...(await importOriginal<typeof authApi>()),
  getMe: vi.fn(),
  logout: vi.fn(),
}));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    {children}
  </QueryClientProvider>
);

describe('App Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(clustersApi.listClusters).mockResolvedValue([]);
    vi.mocked(deploymentsApi.listDeployments).mockResolvedValue([]);
    vi.mocked(credentialsApi.listProviders).mockResolvedValue([]);
    vi.mocked(authApi.getMe).mockResolvedValue({ id: 'u1', email: 'u@example.com' });
  });

  it('renders the sidebar with one Infrastructure entry', async () => {
    render(<App />, { wrapper });
    await waitFor(() => {
      expect(screen.getByText('NO WRINKLES')).toBeInTheDocument();
      expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    });
    expect(screen.queryByText('Clusters')).toBeNull();
    expect(screen.queryByText('Applications')).toBeNull();
  });

  it('opens Infrastructure with its apps and clusters on the page', async () => {
    render(<App />, { wrapper });
    fireEvent.click(await screen.findByText('Infrastructure'));
    expect(await screen.findByRole('button', { name: /Provision a cluster/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Deploy an app/ })).toBeInTheDocument();
  });
});
