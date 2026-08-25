import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as authApi from '../api/auth';
import * as credentialsApi from '../api/credentials';

/**
 * Mocked at the API modules, not at axios — `vi.mock('axios')` cannot reach the instance
 * `api/client` builds with `axios.create()`.
 *
 * `getMe` returning a user is what gets past the login gate: App renders Login until the session
 * query resolves, so an unmocked one leaves every assertion here looking at a form.
 */
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

    /**
     * Chat is the landing view now, so this navigates to Clusters first.
     *
     * It used to be 'clusters' — a table of infrastructure, which is what you look at when
     * something is wrong rather than when you arrive. This test asserted the old front door and
     * caught the change, which is what it is for.
     */
    fireEvent.click(screen.getByText('Clusters'));
    expect(screen.getByText('Infrastructures')).toBeInTheDocument();
    
    // Switch to apps
    const appsButton = screen.getByRole('button', { name: /applications/i });
    appsButton.click();
    
    await waitFor(() => {
      expect(screen.getByText('Deploy application instances.')).toBeInTheDocument();
    });
  });
});
