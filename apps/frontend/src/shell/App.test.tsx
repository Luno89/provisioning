import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../features/infrastructure/api/clusters';
import * as deploymentsApi from '../features/infrastructure/api/deployments';
import * as authApi from '../features/platform/api';
import * as credentialsApi from '../features/infrastructure/api/credentials';
import * as identityApi from '../features/instances/api/identity';
import { signedInShell } from '../test/signed-in';

vi.mock('../features/instances/api/identity', async (importOriginal) => (await import('../test/mocked-module')).withResolved(importOriginal<typeof identityApi>, { getMyInstance: { instance: null, servesTenants: true } }));
vi.mock('../features/infrastructure/api/clusters', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof clustersApi>, 'listClusters'));
vi.mock('../features/infrastructure/api/deployments', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof deploymentsApi>, 'listDeployments'));
vi.mock('../features/infrastructure/api/credentials', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof credentialsApi>, 'listProviders'));
vi.mock('../features/platform/api', async (importOriginal) => (await import('../test/mocked-module')).withMocked(importOriginal<typeof authApi>, 'getMe', 'logout'));

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
  beforeEach(signedInShell);

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
    expect(await screen.findByRole('button', { name: /Deploy an app/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Provision a cluster/ })).toBeNull();
  });
});
