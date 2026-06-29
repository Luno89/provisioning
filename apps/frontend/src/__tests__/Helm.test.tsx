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

describe('Helm Status Tab', () => {
  it('shows helm status when the tab is clicked', async () => {
    const queryClient = createTestQueryClient();
    vi.clearAllMocks();
    
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/helm')) {
        return Promise.resolve({ data: { content: 'STATUS: deployed' } });
      }
      if (url.includes('/deployments')) {
        return Promise.resolve({ data: [{ id: 'd1', name: 'Odoo', clusterId: 'c1', status: 'running', strategy: 'helm' }] });
      }
      if (url.includes('/clusters')) {
        return Promise.resolve({ data: [{ id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d' }] });
      }
      return Promise.resolve({ data: [] });
    });

    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Switch to Applications view
    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    await user.click(appsBtn);

    // Click Manage for the Odoo deployment
    const logsBtn = await screen.findByRole('button', { name: /manage/i });
    await user.click(logsBtn);

    // Click Helm Status tab
    const helmTab = await screen.findByText(/Helm Status/i);
    await user.click(helmTab);

    // Check for content
    await waitFor(() => {
      expect(screen.getByText(/STATUS: deployed/i)).toBeInTheDocument();
    }, { timeout: 10000 });
  });
});
