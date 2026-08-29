import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as authApi from '../api/auth';
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
vi.mock('../api/auth', async (importOriginal) => ({
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

  it('renders the sidebar and main header', async () => {
    render(<App />, { wrapper });
    expect(screen.getByText('NO WRINKLES')).toBeInTheDocument();
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });

  it('switches between Clusters and Applications views', async () => {
    render(<App />, { wrapper });

    fireEvent.click(screen.getByText('Clusters'));
    expect(screen.getByText('Infrastructures')).toBeInTheDocument();
    
    const appsButton = screen.getByRole('button', { name: /applications/i });
    appsButton.click();
    
    await waitFor(() => {
      expect(screen.getByText('Deploy application instances.')).toBeInTheDocument();
    });
  });
});
