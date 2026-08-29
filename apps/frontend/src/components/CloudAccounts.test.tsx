import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CloudAccounts from './CloudAccounts';
import { PROVIDERS } from './credential-providers';
import * as credentialsApi from '../api/credentials';
import type { ProviderStatus } from '../types/credentials';

vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof credentialsApi>()),
  listProviders: vi.fn(),
  getDriveStatus: vi.fn(),
}));

const listProviders = vi.mocked(credentialsApi.listProviders);
const getDriveStatus = vi.mocked(credentialsApi.getDriveStatus);

const renderScreen = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CloudAccounts />
    </QueryClientProvider>,
  );
};

const providers = (...rows: Partial<ProviderStatus>[]): ProviderStatus[] =>
  rows.map((r) => ({ provider: 'aws', label: 'Amazon Web Services', configured: false, ...r }));

beforeEach(() => {
  vi.clearAllMocks();
  getDriveStatus.mockResolvedValue({});
});

describe('CloudAccounts', () => {
  it('renders a card for every provider the API reports', async () => {
    listProviders.mockResolvedValue(providers(
      { provider: 'huggingface', label: 'Hugging Face' },
      { provider: 'github', label: 'GitHub' },
      { provider: 'aws', label: 'Amazon Web Services' },
      { provider: 'gcp', label: 'Google Cloud Platform' },
      { provider: 'azure', label: 'Microsoft Azure' },
      { provider: 'do', label: 'DigitalOcean' },
    ));
    renderScreen();

    for (const label of ['Hugging Face', 'GitHub', 'Amazon Web Services',
      'Google Cloud Platform', 'Microsoft Azure', 'DigitalOcean']) {
      expect(await screen.findByText(label)).toBeDefined();
    }
  });

  it('distinguishes a configured provider from an unconfigured one', async () => {
    listProviders.mockResolvedValue(providers(
      { provider: 'aws', label: 'Amazon Web Services', configured: true, source: 'user' },
      { provider: 'gcp', label: 'Google Cloud Platform', configured: false },
    ));
    renderScreen();

    expect(await screen.findByText('Connected')).toBeDefined();
    expect((await screen.findAllByText('Not Configured')).length).toBeGreaterThan(0);
  });

  it('offers a Configure button for a provider with nothing stored', async () => {
    listProviders.mockResolvedValue(providers({ provider: 'aws', configured: false }));
    renderScreen();
    expect((await screen.findAllByText('Configure')).length).toBeGreaterThan(0);
  });

  it('explains mock cloud mode, which is the zero-setup path', async () => {
    listProviders.mockResolvedValue(providers({ configured: false }));
    renderScreen();
    expect((await screen.findAllByText(/Mock Cloud Mode/i)).length).toBeGreaterThan(0);
  });

  it('shows a spinner before the first response arrives', () => {
    listProviders.mockReturnValue(new Promise(() => {}));
    const { container } = renderScreen();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders the grid even when the Drive request fails', async () => {
    getDriveStatus.mockRejectedValue(new Error('not supported'));
    listProviders.mockResolvedValue(providers({ provider: 'aws', label: 'Amazon Web Services' }));
    renderScreen();
    expect(await screen.findByText('Amazon Web Services')).toBeDefined();
  });
});

describe('the provider catalogue', () => {
  it('is a real list, not a hardcoded count', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
    for (const p of PROVIDERS) {
      expect(p.key, JSON.stringify(p)).toBeTruthy();
      expect(p.label, p.key).toBeTruthy();
      expect(p.fields.length, p.key).toBeGreaterThan(0);
    }
  });
});
