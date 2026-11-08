import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CloudAccounts from './CloudAccounts';
import { PROVIDERS } from '../lib/credential-providers';
import * as credentialsApi from '../api/credentials';
import type { ProviderStatus } from '../types/credentials';

vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof credentialsApi>()),
  listProviders: vi.fn(),
  getDriveStatus: vi.fn(),
  listDnsProviders: vi.fn(),
}));

const listProviders = vi.mocked(credentialsApi.listProviders);
const getDriveStatus = vi.mocked(credentialsApi.getDriveStatus);
const listDnsProviders = vi.mocked(credentialsApi.listDnsProviders);
const PORKBUN = {
  name: 'porkbun', label: 'Porkbun DNS', docsUrl: 'https://porkbun.com/account/api', setup: 'Turn on API Access for each domain.',
  fields: [{ key: 'apiKey', label: 'API Key', secret: true, placeholder: 'pk1_…', optional: false }, { key: 'secretApiKey', label: 'Secret API Key', secret: true, placeholder: 'sk1_…', optional: false }],
};

const renderScreen = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CloudAccounts />
    </QueryClientProvider>,
  );
};

const providers = (...rows: Partial<ProviderStatus>[]): ProviderStatus[] =>
  rows.map((r) => ({ provider: 'ovh', label: 'OVHcloud', configured: false, ...r }));

beforeEach(() => {
  listDnsProviders.mockResolvedValue([PORKBUN]);
  vi.clearAllMocks();
  getDriveStatus.mockResolvedValue({});
});

describe('CloudAccounts', () => {
  it('renders a card for every provider the API reports', async () => {
    listProviders.mockResolvedValue(providers(
      { provider: 'huggingface', label: 'Hugging Face' },
      { provider: 'ovh', label: 'OVHcloud' },
    ));
    renderScreen();

    for (const label of ['Hugging Face', 'OVHcloud']) {
      expect(await screen.findByText(label)).toBeDefined();
    }
    expect(screen.queryByText('GitHub')).toBeNull();
  });

  it('distinguishes a configured provider from an unconfigured one', async () => {
    listProviders.mockResolvedValue(providers(
      { provider: 'huggingface', label: 'Hugging Face', configured: true, source: 'user' },
      { provider: 'ovh', label: 'OVHcloud', configured: false },
    ));
    renderScreen();

    expect(await screen.findByText('Connected')).toBeDefined();
    expect((await screen.findAllByText('Not Configured')).length).toBeGreaterThan(0);
  });

  it('offers a Configure button for a provider with nothing stored', async () => {
    listProviders.mockResolvedValue(providers({ provider: 'ovh', configured: false }));
    renderScreen();
    expect((await screen.findAllByText('Configure')).length).toBeGreaterThan(0);
  });

  it('says nothing of clusters or mock cloud mode, and offers no cloud a cluster was once made on', async () => {
    listProviders.mockResolvedValue(providers({ configured: false }));
    renderScreen();
    expect((await screen.findAllByText('Configure')).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Mock Cloud Mode/i)).toBeNull();
    expect(screen.queryByText(/clusters are not available yet/i)).toBeNull();
    for (const label of ['Amazon Web Services', 'Google Cloud Platform', 'Microsoft Azure', 'DigitalOcean', 'Hetzner Cloud']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('shows a spinner before the first response arrives', () => {
    listProviders.mockReturnValue(new Promise(() => {}));
    const { container } = renderScreen();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders the grid even when the Drive request fails', async () => {
    getDriveStatus.mockRejectedValue(new Error('not supported'));
    listProviders.mockResolvedValue(providers({ provider: 'ovh', label: 'OVHcloud' }));
    renderScreen();
    expect(await screen.findByText('OVHcloud')).toBeDefined();
  });
});

describe('DNS providers', () => {
  it('lists each one the server\'s registry describes, with how to set it up, instead of a hand-written entry', async () => {
    listProviders.mockResolvedValue(providers());
    renderScreen();
    expect(await screen.findByText('Porkbun DNS')).toBeDefined();
    expect(screen.getByText('Turn on API Access for each domain.')).toBeDefined();
    expect(PROVIDERS.some((provider) => provider.key === 'cloudflare' || provider.key === 'porkbun')).toBe(false);
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
