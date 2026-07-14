import { render, screen, waitFor } from '@testing-library/react';
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

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>
    {children}
  </QueryClientProvider>
);

describe('Nginx Ingress Proxy Wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
            status: 'running',
            strategy: 'native',
            appType: 'odoo',
            isExposed: false,
            exposureUrl: ''
          }]
        });
      }
      if (url.includes('/nginx')) {
        return Promise.resolve({ data: { content: 'events {}\nhttp {\n    # Initial config\n}' } });
      }
      return Promise.reject(new Error('Not found'));
    });

    mockedAxios.post.mockImplementation((url) => {
      if (url.includes('/nginx')) {
        return Promise.resolve({ data: { success: true } });
      }
      return Promise.reject(new Error('Not found'));
    });
  });

  it('guides the user through Nginx Proxy Wizard and injects config block', async () => {
    const user = userEvent.setup();
    render(<App />, { wrapper });

    // Go to Nginx Router view
    await user.click(screen.getByRole('button', { name: /nginx router/i }));
    
    // Verify Nginx header and Save button are visible
    expect(await screen.findByText('Nginx Router Settings')).toBeInTheDocument();
    
    // Open Proxy Wizard
    const wizardBtn = await screen.findByRole('button', { name: /proxy wizard/i });
    await user.click(wizardBtn);
    expect(screen.getByText('Proxy Exposure Wizard')).toBeInTheDocument();

    // Step 1: Select Application
    expect(screen.getByText('Select Application')).toBeInTheDocument();
    const appSelect = screen.getByRole('combobox', { name: /application instance/i });
    await user.selectOptions(appSelect, 'd1');
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Domain Configuration
    await waitFor(() => expect(screen.getByText('Domain & Traffic Settings')).toBeInTheDocument());
    const domainInput = screen.getByRole('textbox', { name: /proxy hostname/i });
    expect(domainInput).toHaveValue('odoo-production.vpn.local');
    await user.clear(domainInput);
    await user.type(domainInput, 'odoo-custom.vpn.local');
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 3: Review & Inject
    await waitFor(() => {
      expect(screen.getByText(/proxy_pass http.+(upstream|proxy_pass).+/i)).toBeInTheDocument();
    });

    // Click Inject
    const injectBtn = screen.getByRole('button', { name: /inject into config & close/i });
    await user.click(injectBtn);

    // Verify modal is closed
    await waitFor(() => expect(screen.queryByText('Proxy Exposure Wizard')).not.toBeInTheDocument());

    // Verify Nginx.conf textarea contains inject block (generic)
    const textarea = screen.getByPlaceholderText('Loading configuration...') as HTMLTextAreaElement;
    expect(textarea.value).toContain('server_name odoo-custom.vpn.local;');
    expect(textarea.value).toContain('proxy_pass http://');
    expect(textarea.value).toMatch(/upstream|proxy_pass/);
  });
});
