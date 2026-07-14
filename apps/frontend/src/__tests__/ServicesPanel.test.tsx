import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ServicesPanel from '../ServicesPanel';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: { services: [] } });
    });

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: mockClusters });
      }
      return Promise.resolve({ data: mockServices });
    });

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServices });
    });

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServices });
    });

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServicesWithTraefik });
    });

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

    expect(links[0].closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/prometheus/'),
    );
    expect(links[1].closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/grafana/'),
    );
    expect(links[2].closest('a')).toHaveAttribute(
      'href',
      expect.stringContaining('/proxy/traefik/'),
    );
  });

  it('hides "Open Dashboard" link when service not deployed', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServices });
    });

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
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServices });
    });

    render(<ServicesPanel />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
      ),
    });

    await waitFor(() => {
      expect(screen.getByText('Prometheus Monitoring')).toBeInTheDocument();
    });

    const link = screen.getAllByText('Open Dashboard')[0].closest('a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('shows correct status badges', async () => {
    mockedAxios.get.mockImplementation((url: string) => {
      if (String(url).includes('/clusters') && !String(url).includes('/services')) {
        return Promise.resolve({ data: [mockClusters[0]] });
      }
      return Promise.resolve({ data: mockServices });
    });

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
