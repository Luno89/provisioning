import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import { router } from '../router';
import * as authApi from '../api/auth';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as credentialsApi from '../api/credentials';
import * as groveApi from '../api/grove';

vi.mock('../api/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof authApi>()),
  getMe: vi.fn(),
  logout: vi.fn(),
}));
vi.mock('../api/clusters', async (importOriginal) => ({
  ...(await importOriginal<typeof clustersApi>()),
  listClusters: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/deployments', async (importOriginal) => ({
  ...(await importOriginal<typeof deploymentsApi>()),
  listDeployments: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof credentialsApi>()),
  listProviders: vi.fn().mockResolvedValue([]),
}));
vi.mock('../api/grove', async (importOriginal) => ({
  ...(await importOriginal<typeof groveApi>()),
  listTrees: vi.fn().mockResolvedValue([]),
  listBranches: vi.fn().mockResolvedValue([]),
}));

const createTestQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });

describe('TanStack Router configuration and route matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authApi.getMe).mockResolvedValue({ id: 'test-user', email: 'test@example.com' });
  });

  it('renders application with router and navigates to clusters', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('NO WRINKLES')).toBeInTheDocument();
    });

    const clustersBtn = screen.getByRole('button', { name: /clusters/i });
    fireEvent.click(clustersBtn);

    await waitFor(() => {
      expect(screen.getByText('Infrastructures')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/clusters');
    });
  });

  it('navigates to applications view', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    fireEvent.click(appsBtn);

    await waitFor(() => {
      expect(screen.getByText('Deploy application instances.')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/apps');
    });
  });

  it('navigates to projects view', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    const projectsBtn = await screen.findByRole('button', { name: /^projects/i });
    fireEvent.click(projectsBtn);

    await waitFor(() => {
      expect(screen.getByText(/everything koala is working on/i)).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/projects');
    });
  });

  it('navigates to personas view', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    const personasBtn = await screen.findByRole('button', { name: /personas/i });
    fireEvent.click(personasBtn);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/personas');
    });
  });

  it('navigates to lab and settings views', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    const labBtn = await screen.findByRole('button', { name: /lab/i });
    fireEvent.click(labBtn);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/lab');
    });

    await router.navigate({ to: '/settings' });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings');
    });
  });

  it('supports deep link navigation to project tree via router.navigate', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    await router.navigate({ to: '/projects/tree/$treeId', params: { treeId: 't-test-123' } });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/projects/tree/t-test-123');
      expect(screen.getByText(/back to projects/i)).toBeInTheDocument();
    });
  });
});
