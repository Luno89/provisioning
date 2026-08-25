import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * Mocked at the API MODULES, not at fetch.
 *
 * The wizard used to make four raw `fetch` calls with hand-written URLs and had no test file at
 * all. These tests pin the credentials step's behaviour through the same boundary every other
 * converted screen uses. The catalog and mesh effects are mocked so the hetzner/remote branches
 * do not hit the network when they fire.
 */
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

import ClusterWizard from './ClusterWizard.js';
import { validateCredentials } from '../api/credentials';

const mockedValidate = vi.mocked(validateCredentials);

beforeEach(() => {
  vi.clearAllMocks();
});

const goToTokenStep = () => {
  fireEvent.change(screen.getByPlaceholderText(/production-omega/i), {
    target: { value: 'test-cluster' },
  });
  fireEvent.change(screen.getByDisplayValue(/local datacenter/i), {
    target: { value: 'hetzner' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^next/i }));
};

describe('ClusterWizard credentials step', () => {
  it('validates a token through the api layer and shows the result', async () => {
    mockedValidate.mockResolvedValue({ valid: true, message: 'Token works' } as never);

    render(<ClusterWizard configuredProviders={[]} onSubmit={() => {}} onCancel={() => {}} />);

    goToTokenStep();
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

    render(<ClusterWizard configuredProviders={[]} onSubmit={() => {}} onCancel={() => {}} />);

    goToTokenStep();
    fireEvent.change(screen.getByPlaceholderText(/read & write token/i), {
      target: { value: 'bad-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^test$/i }));

    await waitFor(() => {
      expect(screen.getByText(/validation failed: 401 unauthorized/i)).toBeInTheDocument();
    });
  });
});
