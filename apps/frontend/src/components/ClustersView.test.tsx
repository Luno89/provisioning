import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ClustersView from './ClustersView';
import * as clustersApi from '../api/clusters';
import { useShellStore } from '../stores/shell';
import type { Cluster } from '../types/cluster';

vi.mock('../api/clusters', async (importOriginal) => ({
  ...(await importOriginal<typeof clustersApi>()),
  useClusterDetail: vi.fn(),
}));

const useClusterDetail = vi.mocked(clustersApi.useClusterDetail);

const EMPTY = {
  pods: undefined, podError: null, loadingPods: false,
  helmReleases: undefined, loadingHelm: false,
  gpuStatus: undefined, loadingGpu: false,
} as unknown as ReturnType<typeof clustersApi.useClusterDetail>;

const cluster = (over: Partial<Cluster> = {}): Cluster => ({
  id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d', gpuEnabled: true, ...over,
});

const renderView = (clusters: Cluster[] = [cluster()]) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onProvision = vi.fn();
  const onOpenLogs = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <ClustersView clusters={clusters} onProvision={onProvision} onOpenLogs={onOpenLogs} />
    </QueryClientProvider>,
  );
  return { onProvision, onOpenLogs };
};

beforeEach(() => {
  vi.clearAllMocks();
  useClusterDetail.mockReturnValue(EMPTY);
  useShellStore.setState({ confirmDestroy: null });
});

describe('the clusters screen', () => {
  it('lists each cluster', () => {
    renderView([cluster({ id: 'a', name: 'alpha' }), cluster({ id: 'b', name: 'beta' })]);
    expect(screen.getByText('alpha')).toBeDefined();
    expect(screen.getByText('beta')).toBeDefined();
  });

  it('asks App to open the provision wizard rather than reaching for its state', () => {
    const { onProvision } = renderView();
    screen.getByText(/Provision Cluster/i).click();
    expect(onProvision).toHaveBeenCalled();
  });

  it('marks the system cluster read-only, with no destroy button', () => {
    renderView([cluster({ id: 'sys', name: 'provisioning-lunorica', isSystem: true })]);
    expect(screen.getByText('System')).toBeDefined();
    expect(screen.queryByTitle(/destroy/i)).toBeNull();
  });
});

describe('the health inspector', () => {
  it('shows pods and GPU availability once a row is expanded', async () => {
    useClusterDetail.mockReturnValue({
      ...EMPTY,
      pods: [{
        metadata: { name: 'pod-1', namespace: 'kube-system' },
        status: { phase: 'Running' },
      }],
      gpuStatus: {
        passthroughEnabled: true, hasGpu: true, vendor: 'NVIDIA',
        totalCapacity: 1, totalAllocatable: 1, totalAllocated: 0, availableGpus: 1,
        nodes: [{ name: 'k3d-node-1', gpuCapacity: 1, gpuAllocatable: 1, nvidiaGpus: 1, amdGpus: 0 }],
        devicePlugins: [{ name: 'nvidia-device-plugin-ds', vendor: 'NVIDIA', status: 'active', readyPods: 1, desiredPods: 1 }],
        gpuPods: [],
      },
    } as unknown as ReturnType<typeof clustersApi.useClusterDetail>);

    const user = userEvent.setup();
    renderView();
    await user.click(await screen.findByText(/Cluster Inspector/i));

    await waitFor(() => {
      expect(screen.getByText('pod-1')).toBeDefined();
      expect(screen.getByText('kube-system')).toBeDefined();
      expect(screen.getByText(/GPU Acceleration & Availability/i)).toBeDefined();
      expect(screen.getByText(/1 \/ 1 GPU Available/i)).toBeDefined();
    });
  });

  it('queries nothing until a row is expanded', () => {
    renderView();
    expect(useClusterDetail).toHaveBeenCalledWith(null);
  });
});
