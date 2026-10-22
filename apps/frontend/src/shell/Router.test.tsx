import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import { router } from './router';
import * as authApi from '../features/platform/api';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as credentialsApi from '../api/credentials';
import * as groveApi from '../features/projects/api/grove';

vi.mock('../features/platform/api', async (importOriginal) => ({
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
vi.mock('../features/projects/api/grove', async (importOriginal) => ({
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

  it('opens Infrastructure from the sidebar', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /infrastructure/i }));

    await waitFor(() => {
      expect(screen.getByTestId('infrastructure-overview')).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/infrastructure');
    });
  });

  it('sends the pages folded into Infrastructure to their section', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );
    await screen.findByRole('button', { name: /infrastructure/i });

    for (const [from, to] of [['/clusters', '/infrastructure/clusters'], ['/apps', '/infrastructure/apps'], ['/services', '/infrastructure/clusters'], ['/running', '/infrastructure/running'], ['/monitoring', '/infrastructure'], ['/monitoring/app/books', '/infrastructure/app/books']] as const) {
      await act(async () => { await router.navigate({ to: from as never }); });
      await waitFor(() => expect(router.state.location.pathname, from).toBe(to));
    }
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

  it('navigates to an agent\'s page through Studio, and sends the old pages there', async () => {
    const qc = createTestQueryClient();
    render(
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    );

    fireEvent.click(await screen.findByRole('button', { name: /^agents$/i }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/studio/agents');
    });

    await router.navigate({ to: '/memories' });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/studio/agents/memory-keeper/memories');
    });

    await router.navigate({ to: '/studio/$procedureId', params: { procedureId: 'tool-rounds' } });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/studio/procedures/tool-rounds');
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
