import { render, screen, waitFor } from '@testing-library/react';
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

describe('App Dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockImplementation((url) => {
      if (url.includes('/clusters')) return Promise.resolve({ data: [] });
      if (url.includes('/deployments')) return Promise.resolve({ data: [] });
      return Promise.reject(new Error('Not found'));
    });
  });

  it('renders the sidebar and main header', async () => {
    render(<App />, { wrapper });
    expect(screen.getByText('Provisioner v2')).toBeInTheDocument();
    expect(screen.getByText('Clusters')).toBeInTheDocument();
    expect(screen.getByText('Applications')).toBeInTheDocument();
  });

  it('switches between Clusters and Applications views', async () => {
    render(<App />, { wrapper });
    
    // Default view is clusters
    expect(screen.getByText('Infrastructures')).toBeInTheDocument();
    
    // Switch to apps
    const appsButton = screen.getByRole('button', { name: /applications/i });
    appsButton.click();
    
    await waitFor(() => {
      expect(screen.getByText('Deploy ERP instances.')).toBeInTheDocument();
    });
  });
});
