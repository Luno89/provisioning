import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../api/credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/credentials')>()),
  validateCredentials: vi.fn(),
  saveCredentials: vi.fn(),
}));

vi.mock('../api/vps-catalog', () => ({
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
