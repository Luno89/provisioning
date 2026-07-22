import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const createTestQueryClient = () => new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      gcTime: 0,
      staleTime: 0,
    },
  },
});

describe('Cluster Health Inspector', () => {
  it('expands the health inspector and shows pods', async () => {
    const queryClient = createTestQueryClient();
    vi.clearAllMocks();

    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/all-pods')) {
        return Promise.resolve({ data: [
          { 
            metadata: { 
              name: 'pod-1', 
              namespace: 'kube-system', 
              creationTimestamp: new Date().toISOString() 
            }, 
            status: { 
              phase: 'Running',
              podIP: '1.2.3.4'
            } 
          }
        ]});
      }
      if (url.includes('/gpu-status')) {
        return Promise.resolve({
          data: {
            passthroughEnabled: true,
            hasGpu: true,
            vendor: 'NVIDIA',
            totalCapacity: 1,
            totalAllocatable: 1,
            totalAllocated: 0,
            availableGpus: 1,
            nodes: [{ name: 'k3d-node-1', gpuCapacity: 1, gpuAllocatable: 1, nvidiaGpus: 1, amdGpus: 0 }],
            devicePlugins: [{ name: 'nvidia-device-plugin-ds', vendor: 'NVIDIA', status: 'active', readyPods: 1, desiredPods: 1 }],
            gpuPods: []
          }
        });
      }
      if (url.includes('/clusters')) {
        return Promise.resolve({ data: [{ id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d', gpuEnabled: true }] });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Wait for the cluster to render
    const inspectorButton = await screen.findByText(/Cluster Inspector/i);
    await user.click(inspectorButton);

    // Verify pod data appears
    await waitFor(() => {
      expect(screen.getByText('pod-1')).toBeInTheDocument();
      expect(screen.getByText('kube-system')).toBeInTheDocument();
      expect(screen.getByText('Running')).toBeInTheDocument();
      expect(screen.getByText(/GPU Acceleration & Availability/i)).toBeInTheDocument();
      expect(screen.getByText(/NVIDIA GPU Acceleration/i)).toBeInTheDocument();
      expect(screen.getByText(/1 \/ 1 GPU Available/i)).toBeInTheDocument();
    }, { timeout: 15000 });
  });
});
