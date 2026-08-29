import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import * as clustersApi from '../api/clusters';
import * as deploymentsApi from '../api/deployments';
import * as nginxApi from '../api/nginx';
import * as authApi from '../api/auth';
import * as credentialsApi from '../api/credentials';

vi.mock('../api/clusters', async (o) => ({ ...(await o<typeof clustersApi>()), listClusters: vi.fn() }));
vi.mock('../api/deployments', async (o) => ({ ...(await o<typeof deploymentsApi>()), listDeployments: vi.fn() }));
vi.mock('../api/credentials', async (o) => ({ ...(await o<typeof credentialsApi>()), listProviders: vi.fn() }));
vi.mock('../api/auth', async (o) => ({ ...(await o<typeof authApi>()), getMe: vi.fn(), logout: vi.fn() }));
vi.mock('../api/nginx', async (o) => ({
  ...(await o<typeof nginxApi>()), getNginxConfig: vi.fn(), saveNginxConfig: vi.fn(),
}));

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
    vi.mocked(authApi.getMe).mockResolvedValue({ id: 'u1', email: 'u@example.com' });
    vi.mocked(credentialsApi.listProviders).mockResolvedValue([]);
    vi.mocked(clustersApi.listClusters).mockResolvedValue(
      [{ id: 'c1', name: 'Dev-Cluster', status: 'healthy', provider: 'k3d' }] as never,
    );
    vi.mocked(deploymentsApi.listDeployments).mockResolvedValue([{
      id: 'd1',
      name: 'Odoo-Production',
      clusterId: 'c1',
      status: 'running',
      strategy: 'native',
      appType: 'odoo',
      isExposed: false,
      exposureUrl: '',
    }] as never);
    vi.mocked(nginxApi.getNginxConfig).mockResolvedValue(
      { content: 'events {}\nhttp {\n    # Initial config\n}' },
    );
    vi.mocked(nginxApi.saveNginxConfig).mockResolvedValue(undefined);
  });

  it('guides the user through Nginx Proxy Wizard and injects config block', async () => {
    const user = userEvent.setup();
    render(<App />, { wrapper });

    await user.click(screen.getByRole('button', { name: /nginx router/i }));
    
    expect(await screen.findByText('Nginx Router Settings')).toBeInTheDocument();
    
    const wizardBtn = await screen.findByRole('button', { name: /proxy wizard/i });
    await user.click(wizardBtn);
    expect(screen.getByText('Proxy Exposure Wizard')).toBeInTheDocument();

    expect(screen.getByText('Select Application')).toBeInTheDocument();
    const appSelect = screen.getByRole('combobox', { name: /application instance/i });
    await user.selectOptions(appSelect, 'd1');
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => expect(screen.getByText('Domain & Traffic Settings')).toBeInTheDocument());
    const domainInput = screen.getByRole('textbox', { name: /proxy hostname/i });
    expect(domainInput).toHaveValue('odoo-production.vpn.local');
    await user.clear(domainInput);
    await user.type(domainInput, 'odoo-custom.vpn.local');
    await user.click(screen.getByRole('button', { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText(/proxy_pass http.+(upstream|proxy_pass).+/i)).toBeInTheDocument();
    });

    const injectBtn = screen.getByRole('button', { name: /inject into config & close/i });
    await user.click(injectBtn);

    await waitFor(() => expect(screen.queryByText('Proxy Exposure Wizard')).not.toBeInTheDocument());

    const textarea = screen.getByPlaceholderText('Loading configuration...') as HTMLTextAreaElement;
    expect(textarea.value).toContain('server_name odoo-custom.vpn.local;');
    expect(textarea.value).toContain('proxy_pass http://');
    expect(textarea.value).toMatch(/upstream|proxy_pass/);
  });
});
