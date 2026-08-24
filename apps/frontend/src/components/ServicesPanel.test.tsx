import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ServicesPanel from './ServicesPanel';
import * as clustersApi from '../api/clusters';

/**
 * Mocked at the API module, not at axios.
 *
 * Nine blocks here matched on URL substrings — and two of them had to disambiguate `/clusters`
 * from `/clusters/:id/services` by hand, which is the tell that the test was reimplementing
 * routing. `vi.mock('axios')` also cannot reach the instance `api/client` builds with
 * `axios.create()`, so all of it would have silently stopped firing anyway.
 *
 * Two named functions replace the string matching: what the cluster list returns, and what the
 * services call returns. No test in this file knows a URL.
 */
vi.mock('../api/clusters', async (importOriginal) => ({
  ...(await importOriginal<typeof clustersApi>()),
  listClusters: vi.fn(),
  listClusterServices: vi.fn(),
}));

/** Stands in for the two calls the panel makes. `services` unwraps to an array now. */
const serving = (clusters: unknown[], services: unknown[]) => {
  vi.mocked(clustersApi.listClusters).mockResolvedValue(clusters as never);
  vi.mocked(clustersApi.listClusterServices).mockResolvedValue(services as never);
};

const createTestQueryClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
});

const mockClusters = [
  { id: 'c1', name: 'dev-cluster', provider: 'k3d', status: 'healthy' },
  { id: 'c2', name: 'other-cluster', provider: 'k3d', status: 'provisioning' },
];

const mockServices = {
  services: [
    {
      name: 'prometheus',
      installed: true,
      status: 'deployed',
      chart: 'kube-prometheus-stack',
      appVersion: '0.72.0',
      namespace: 'monitoring',
      pods: [
        { name: 'prometheus-pod-1', status: 'Running', ip: '10.0.0.1', ready: true },
      ],
    },
    {
      name: 'grafana',
      installed: true,
      status: 'deployed',
      chart: 'kube-prometheus-stack',
      appVersion: '11.1.0',
      namespace: 'monitoring',
      pods: [
        { name: 'grafana-pod-1', status: 'Running', ip: '10.0.0.2', ready: true },
      ],
    },
    {
      name: 'traefik',
      installed: false,
      status: 'not-installed',
      chart: null,
      appVersion: null,
      namespace: 'kube-system',
      pods: [],
    },
  ],
};

const mockServicesWithTraefik = {
  services: [
    ...mockServices.services.filter(s => s.name !== 'traefik'),
    {
      name: 'traefik',
      installed: true,
      status: 'deployed',
      chart: 'traefik',
      appVersion: '3.1.0',
      namespace: 'kube-system',
      pods: [
        { name: 'traefik-pod-1', status: 'Running', ip: '10.0.0.3', ready: true },
      ],
    },
  ],
};

describe('ServicesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no healthy clusters', async () => {
    serving([], []);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('No Healthy Clusters')).toBeInTheDocument();
    });
  });

  it('hides unhealthy clusters from selector', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getAllByText('dev-cluster').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText('other-cluster')).not.toBeInTheDocument();
  });

  it('renders service cards with correct labels', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
      expect(screen.getByText('Grafana Dashboards')).toBeInTheDocument();
      expect(screen.getByText('Traefik Ingress Router')).toBeInTheDocument();
    });
  });

  it('displays pod counts and versions', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    expect(screen.getByText('0.72.0')).toBeInTheDocument();
    expect(screen.getByText('11.1.0')).toBeInTheDocument();
    expect(screen.getAllByText('1/1').length).toBeGreaterThanOrEqual(1);
  });

  it('shows "Open Dashboard" links for deployed services', async () => {
    // Needs the Traefik variant: this asserts THREE links, and the base fixture has Traefik
    // uninstalled. The URL-matching mock this replaced picked the right fixture by which
    // `mockedAxios` block the test happened to define, which is how the distinction stayed
    // invisible.
    serving(mockClusters, mockServicesWithTraefik.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    const links = screen.getAllByText('Open Dashboard');
    expect(links).toHaveLength(3);

    expect(links[0]!.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/prometheus/'),
    );
    expect(links[1]!.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/grafana/'),
    );
    expect(links[2]!.closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/traefik/'),
    );
  });

  it('hides "Open Dashboard" link when service not deployed', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    // Only prometheus and grafana have Open Dashboard, traefik does not
    const links = screen.getAllByText('Open Dashboard');
    expect(links).toHaveLength(2);
  });

  it('dashboard links open in new tab', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    const link = screen.getAllByText('Open Dashboard')[0]!.closest('a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows correct status badges', async () => {
    serving(mockClusters, mockServices.services);

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    const deployedBadges = screen.getAllByText('deployed');
    expect(deployedBadges.length).toBeGreaterThanOrEqual(2);

    const notInstalledBadge = screen.getByText('Not Installed');
    expect(notInstalledBadge).toBeInTheDocument();
  });
});
