import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/credentials')>()),
  validateCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

vi.mock('../api/vps-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/vps-catalog')>()),
  getVpsCatalog: vi.fn().mockResolvedValue({ offers: [], sources: [], fetchedAt: '' }),
}));

vi.mock('../api/mesh', () => ({
  listMeshDevices: vi.fn().mockResolvedValue([]),
}));

vi.mock('../api/cluster-providers', () => ({
  listClusterProviders: vi.fn().mockResolvedValue([
    { value: 'k3d', label: 'Local Datacenter (k3d)', hasCatalog: false, usesMesh: false },
    {
      value: 'hetzner',
      label: 'Hetzner Cloud (VPS)',
      credentialKey: 'hetzner',
      hint: 'Creates a real VM.',
      hasCatalog: true,
      usesMesh: false,
    },
    { value: 'remote', label: 'One of my machines', hasCatalog: false, usesMesh: true },
  ]),
}));

import ClusterWizard from './ClusterWizard.js';
import { validateCredentials } from '../api/credentials';
import { listClusterProviders } from '../api/cluster-providers';

const mockedValidate = vi.mocked(validateCredentials);
const mockedList = vi.mocked(listClusterProviders);

beforeEach(() => {
  vi.clearAllMocks();
});

const goToTokenStep = async () => {
  await screen.findByDisplayValue(/local datacenter/i);
  fireEvent.change(screen.getByPlaceholderText(/production-omega/i), {
    target: { value: 'test-cluster' },
  });
  fireEvent.change(screen.getByDisplayValue(/local datacenter/i), {
    target: { value: 'hetzner' },
  });
  await waitFor(() => expect(screen.getByRole('button', { name: /^next/i })).not.toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: /^next/i }));
};

const renderWizard = (props: Partial<Parameters<typeof ClusterWizard>[0]> = {}) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ClusterWizard configuredProviders={[]} onSubmit={() => {}} onCancel={() => {}} {...props} />
    </QueryClientProvider>,
  );
};

describe('ClusterWizard credentials step', () => {
  it('loads its provider options through the api layer', async () => {
    renderWizard();
    await screen.findByDisplayValue(/local datacenter/i);
    expect(mockedList).toHaveBeenCalled();
  });

  it('validates a token through the api layer and shows the result', async () => {
    mockedValidate.mockResolvedValue({ valid: true, message: 'Token works' } as never);

    renderWizard();

    await goToTokenStep();
    fireEvent.change(screen.getByPlaceholderText(/read & write token/i), {
      target: { value: 'test-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));

    await waitFor(() => {
      expect(mockedValidate).toHaveBeenCalledWith('hetzner', { token: 'test-token' });
      expect(screen.getByText('Token works')).toBeInTheDocument();
    });
  });

  it('shows a failure result when validation rejects', async () => {
    mockedValidate.mockRejectedValue(new Error('401 unauthorized'));

    renderWizard();

    await goToTokenStep();
    fireEvent.change(screen.getByPlaceholderText(/read & write token/i), {
      target: { value: 'bad-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));

    await waitFor(() => {
      expect(screen.getByText(/validation failed: 401 unauthorized/i)).toBeInTheDocument();
    });
  });
});

describe('ClusterWizard plan comparison', () => {
  it('compares plans across providers, and a chosen plan fills in the provider, server and location', async () => {
    const { getVpsCatalog } = await import('../api/vps-catalog');
    const offer = {
      id: 'hetzner:cx53', provider: 'hetzner', planId: 'cx43', provisionable: true, arch: 'x86', cpuType: 'shared', cpuVendor: 'amd',
      locations: ['hel1'], vcpu: 8, ramGb: 16, diskGb: 160, bandwidthTb: 20, currency: 'EUR', pricePerGbRam: 0.6, priceMonthly: 9.49, priceHourly: 0.015, taxIncluded: false,
    };
    vi.mocked(getVpsCatalog).mockResolvedValue({ offers: [offer], sources: [], fetchedAt: '' } as never);
    renderWizard({ configuredProviders: [{ provider: 'hetzner', configured: true }] });
    await screen.findByDisplayValue(/local datacenter/i);
    fireEvent.click(screen.getByRole('button', { name: 'Compare plans across providers' }));
    expect(await screen.findByText('Compare plans')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Use this plan' }));
    expect(await screen.findByDisplayValue(/Hetzner Cloud/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/production-omega/i), { target: { value: 'test-cluster' } });
    fireEvent.click(screen.getByRole('button', { name: /^next/i }));
    await waitFor(() => expect((screen.getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('cx43'));
    expect((screen.getAllByRole('combobox')[1] as HTMLSelectElement).value).toBe('hel1');
  });
});
