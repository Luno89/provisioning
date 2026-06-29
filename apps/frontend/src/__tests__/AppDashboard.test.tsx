import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

describe('Unified Deployment Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/clusters')) {
        return Promise.resolve({ data: [{ id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d' }] });
      }
      if (url.includes('/modules')) {
        return Promise.resolve({
          data: [
            { id: 'sale_delivery_split_date', name: 'Sales Order Delivery Split Date', summary: 'Allows splitting delivery dates.', author: 'Odoo Professional Services', version: '18.0.1.0.0' }
          ]
        });
      }
      if (url.includes('/helm')) {
        return Promise.resolve({ data: { content: 'STATUS: deployed' } });
      }
      if (url.includes('/diagnostics')) {
        return Promise.resolve({ data: { content: 'No diagnostic warnings.' } });
      }
      if (url.includes('/pods')) {
        return Promise.resolve({ data: { namespace: 'odoo', pods: [{ metadata: { name: 'pod-1' }, status: { phase: 'Running' } }] } });
      }
      if (url.includes('/deployments')) {
        return Promise.resolve({
          data: [{
            id: 'd1',
            name: 'Odoo-Production',
            clusterId: 'c1',
            status: 'running',
            strategy: 'helm',
            appType: 'odoo',
            isExposed: false,
            exposureUrl: ''
          }]
        });
      }
      if (url.includes('/logs/')) {
        return Promise.resolve({ data: { content: 'Provisioning log trace...' } });
      }
      return Promise.reject(new Error('Not found'));
    });

    mockedAxios.post.mockImplementation((url) => {
      if (url.includes('/expose') || url.includes('/unexpose')) {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error('Not found'));
    });

    mockedAxios.patch.mockImplementation((url) => {
      if (url.includes('/storage') || url.includes('/modules')) {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error('Not found'));
    });
  });

  it('opens dashboard and displays overview details & handles exposure controls', async () => {
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Navigate to Applications view
    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    await user.click(appsBtn);

    // Verify deployment is shown
    expect(await screen.findByText('Odoo-Production')).toBeInTheDocument();

    // Click "Manage" to open Dashboard
    const manageBtn = screen.getByRole('button', { name: /manage/i });
    await user.click(manageBtn);

    // Verify dashboard is open with default General tab
    expect(await screen.findByText('Odoo-Production Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Network Exposure')).toBeInTheDocument();
    expect(screen.getAllByText('odoo').length).toBeGreaterThan(0);
    expect(screen.getAllByText('helm').length).toBeGreaterThan(0);

    // Click Expose Application
    const exposeBtn = screen.getByRole('button', { name: /expose application/i });
    await user.click(exposeBtn);

    // Verify post mutation was triggered
    expect(mockedAxios.post).toHaveBeenCalledWith(expect.stringContaining('/deployments/d1/expose'));
  });

  it('allows navigating to other tabs like Modules, Diagnostics and Helm', async () => {
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Open Dashboard
    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    await user.click(appsBtn);
    const manageBtn = await screen.findByRole('button', { name: /manage/i });
    await user.click(manageBtn);

    // Switch to Provisioning tab
    const provisionBtn = screen.getByRole('button', { name: /provisioning/i });
    await user.click(provisionBtn);
    expect(await screen.findByText('Provisioning log trace...')).toBeInTheDocument();

    // Switch to Helm Status tab
    const helmBtn = screen.getByRole('button', { name: /helm status/i });
    await user.click(helmBtn);
    expect(await screen.findByText('STATUS: deployed')).toBeInTheDocument();

    // Switch to Diagnostics tab
    const diagBtn = screen.getByRole('button', { name: /diagnostics/i });
    await user.click(diagBtn);
    expect(await screen.findByText('No diagnostic warnings.')).toBeInTheDocument();

    // Switch to Modules tab
    const modulesBtn = screen.getByRole('button', { name: /modules/i });
    await user.click(modulesBtn);
    expect(await screen.findByText('Sales Order Delivery Split Date')).toBeInTheDocument();
  });

  it('displays failure logs on General tab and allows navigation to Provisioning logs on click', async () => {
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/clusters')) {
        return Promise.resolve({ data: [{ id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d' }] });
      }
      if (url.includes('/deployments')) {
        return Promise.resolve({
          data: [{
            id: 'd1',
            name: 'Odoo-Production',
            clusterId: 'c1',
            status: 'failed',
            strategy: 'helm',
            appType: 'odoo',
            isExposed: false,
            exposureUrl: ''
          }]
        });
      }
      if (url.includes('/logs/')) {
        return Promise.resolve({ data: { content: 'mock logs line 1\nmock logs line 2\nFailed with status code 404' } });
      }
      return Promise.resolve({ data: [] });
    });

    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Open Dashboard
    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    await user.click(appsBtn);
    const manageBtn = await screen.findByRole('button', { name: /manage/i });
    await user.click(manageBtn);

    // Verify error card displays deployment failure logs
    expect(await screen.findByText('Deployment Failed')).toBeInTheDocument();
    expect(screen.getByText(/Failed with status code 404/)).toBeInTheDocument();

    // Click "View Full Logs"
    const viewFullBtn = screen.getByRole('button', { name: /view full logs/i });
    await user.click(viewFullBtn);

    // Verify it switched to Provisioning tab by checking if the log container displays full logs
    expect(await screen.findByText(/mock logs line 1/)).toBeInTheDocument();
  });

  it('allows navigating to Storage tab and resizing disks', async () => {
    const queryClient = createTestQueryClient();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Open Dashboard
    const appsBtn = await screen.findByRole('button', { name: /applications/i });
    await user.click(appsBtn);
    const manageBtn = await screen.findByRole('button', { name: /manage/i });
    await user.click(manageBtn);

    // Switch to Storage tab
    expect(await screen.findByText('Odoo-Production Dashboard')).toBeInTheDocument();
    const storageBtn = screen.getByRole('button', { name: /storage/i });
    await user.click(storageBtn);

    // Verify it displays storage fields
    expect(await screen.findByText('Storage Volumes Management')).toBeInTheDocument();
    expect(screen.getByText('Database Volume')).toBeInTheDocument();
    expect(screen.getByText('Current: 2Gi')).toBeInTheDocument();

    // Type a new size
    const input = screen.getByLabelText('Target Size:', { selector: '#vol-size-db' });
    await user.clear(input);
    await user.type(input, '15Gi');

    // Click Apply Changes
    const applyBtn = screen.getByRole('button', { name: /apply changes/i });
    await user.click(applyBtn);

    // Verify patch mutation was triggered with correct parameters
    expect(mockedAxios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/deployments/d1/storage'),
      expect.objectContaining({
        storage: expect.objectContaining({
          db: '15Gi'
        })
      })
    );
  });
});
