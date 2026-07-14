import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CloudAccounts from './CloudAccounts';

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('CloudAccounts', () => {
  const apiBase = 'http://localhost:3001/api';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all provider cards', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        providers: [
          { provider: 'aws', label: 'Amazon Web Services', configured: false },
          { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
          { provider: 'azure', label: 'Microsoft Azure', configured: false },
          { provider: 'do', label: 'DigitalOcean', configured: false },
        ],
      }),
    });

    render(<CloudAccounts apiBase={apiBase} />);

    await waitFor(() => {
      expect(screen.getByText('Amazon Web Services')).toBeDefined();
      expect(screen.getByText('Google Cloud Platform')).toBeDefined();
      expect(screen.getByText('Microsoft Azure')).toBeDefined();
      expect(screen.getByText('DigitalOcean')).toBeDefined();
    });
  });

  it('shows "Not Configured" for unconfigured providers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        providers: [
          { provider: 'aws', label: 'Amazon Web Services', configured: false },
          { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
          { provider: 'azure', label: 'Microsoft Azure', configured: false },
          { provider: 'do', label: 'DigitalOcean', configured: false },
        ],
      }),
    });

    render(<CloudAccounts apiBase={apiBase} />);

    await waitFor(() => {
      const notConfigured = screen.getAllByText('Not Configured');
      expect(notConfigured.length).toBe(4);
    });
  });

  it('shows "Connected" for configured providers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        providers: [
          { provider: 'aws', label: 'Amazon Web Services', configured: true, source: 'user', summary: { AWS_ACCESS_KEY_ID: 'AKIA****MPLE' } },
          { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
          { provider: 'azure', label: 'Microsoft Azure', configured: false },
          { provider: 'do', label: 'DigitalOcean', configured: false },
        ],
      }),
    });

    render(<CloudAccounts apiBase={apiBase} />);

    await waitFor(() => {
      expect(screen.getByText('Connected')).toBeDefined();
    });
  });

  it('shows Configure button for unconfigured providers', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        providers: [
          { provider: 'aws', label: 'Amazon Web Services', configured: false },
          { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
          { provider: 'azure', label: 'Microsoft Azure', configured: false },
          { provider: 'do', label: 'DigitalOcean', configured: false },
        ],
      }),
    });

    render(<CloudAccounts apiBase={apiBase} />);

    await waitFor(() => {
      const configButtons = screen.getAllByText('Configure');
      expect(configButtons.length).toBe(4);
    });
  });

  it('renders the Mock Cloud Mode info banner', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        providers: [
          { provider: 'aws', label: 'Amazon Web Services', configured: false },
          { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
          { provider: 'azure', label: 'Microsoft Azure', configured: false },
          { provider: 'do', label: 'DigitalOcean', configured: false },
        ],
      }),
    });

    render(<CloudAccounts apiBase={apiBase} />);

    await waitFor(() => {
      expect(screen.getByText('Mock Cloud Mode')).toBeDefined();
    });
  });

  it('shows loading state initially', () => {
    mockFetch.mockImplementation(() => new Promise(() => {})); // Never resolves
    render(<CloudAccounts apiBase={apiBase} />);
    // Should not show provider content yet
    expect(screen.queryByText('Amazon Web Services')).toBeNull();
  });
});
