import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../App';
import axios from 'axios';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

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

describe('Deployment Wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/clusters')) return Promise.resolve({ data: [{ id: 'c1', name: 'Test Cluster', status: 'healthy', provider: 'k3d' }] });
      if (url.includes('/deployments')) return Promise.resolve({ data: [] });
      if (url.includes('/registry/tags')) return Promise.resolve({ data: ['18.0', '17.5'] });
      return Promise.reject(new Error('Not found'));
    });
  });

  it('navigates through all 5 steps of the wizard', async () => {
    const user = userEvent.setup();
    const { container } = render(<App />, { wrapper });

    // Go to apps view
    await user.click(screen.getByRole('button', { name: /applications/i }));
    
    // Open wizard
    await user.click(screen.getByRole('button', { name: /deploy app/i }));
    expect(screen.getByText('Deployment Wizard')).toBeInTheDocument();

    // Step 1 -> 2: Target Configuration
    await user.selectOptions(screen.getByRole('combobox', { name: /target cluster/i }), 'c1');
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 2 -> 3: Deployment Strategy
    await waitFor(() => expect(screen.getByText('Deployment Strategy')).toBeInTheDocument());
    await user.click(screen.getByText('Native K8s'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 3: VPN Routing
    await waitFor(() => expect(container.textContent).toContain('Windscribe VPN Routing'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 4: Odoo Component
    await waitFor(() => expect(screen.getByText('Component: Odoo')).toBeInTheDocument());
    await user.click(screen.getByText('18.0'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 4 -> 5: Postgres
    await waitFor(() => expect(screen.getByText('Component: Database')).toBeInTheDocument());
    await user.click(screen.getByText('17.5'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 5: Confirm
    expect(screen.getByText('Ready to Launch')).toBeInTheDocument();
    expect(screen.getByText('Test Cluster')).toBeInTheDocument();
    expect(screen.getByText('native')).toBeInTheDocument();
  });

  it('skips database step when deploying a database-less application', async () => {
    const user = userEvent.setup();
    render(<App />, { wrapper });

    // Go to apps view
    await user.click(screen.getByRole('button', { name: /applications/i }));
    
    // Open wizard
    await user.click(screen.getByRole('button', { name: /deploy app/i }));
    expect(screen.getByText('Deployment Wizard')).toBeInTheDocument();

    // Step 1: Select Audiobookshelf
    await user.selectOptions(screen.getByRole('combobox', { name: /application type/i }), 'audiobookshelf');
    await user.selectOptions(screen.getByRole('combobox', { name: /target cluster/i }), 'c1');
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 2: Deployment Strategy
    await waitFor(() => expect(screen.getByText('Deployment Strategy')).toBeInTheDocument());
    await user.click(screen.getByText('Helm Chart'));
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 3: Component: Audiobookshelf
    await waitFor(() => expect(screen.getByText('Component: Audiobookshelf')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /next/i }));

    // Step 4 (Database) should be skipped! We should be directly on Step 5 (Ready to Launch)
    await waitFor(() => expect(screen.getByText('Ready to Launch')).toBeInTheDocument());
    expect(screen.queryByText('Component: Database')).not.toBeInTheDocument();
    
    // Verify review page does not show Postgres database entry
    expect(screen.queryByText('Database')).not.toBeInTheDocument();
    expect(screen.getByText('Audiobookshelf')).toBeInTheDocument();
  });
});
