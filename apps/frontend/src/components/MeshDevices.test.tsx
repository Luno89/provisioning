import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MeshDevices from './MeshDevices';
import * as meshApi from '../api/mesh';

vi.mock('../api/mesh', async (importOriginal) => ({
  ...(await importOriginal<typeof meshApi>()),
  getMeshConfig: vi.fn(),
  listMeshDevices: vi.fn(),
  createPreauthKey: vi.fn(),
  deleteMeshDevice: vi.fn(),
}));

const renderPanel = (config: unknown, devices: unknown[]) => {
  vi.mocked(meshApi.getMeshConfig).mockResolvedValue(config as never);
  vi.mocked(meshApi.listMeshDevices).mockResolvedValue(devices as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MeshDevices />
    </QueryClientProvider>,
  );
};

const CONFIGURED = { loginServer: 'https://mesh.example.com', configured: true };
const UNCONFIGURED = { loginServer: null, configured: false };

describe('MeshDevices', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('says the mesh is unreachable when no public login server is set', async () => {
    renderPanel(UNCONFIGURED, []);
    await waitFor(() => expect(screen.getByText(/mesh isn't reachable yet/i)).toBeDefined());
    expect(screen.getByRole('button', { name: /generate join command/i })).toHaveProperty('disabled', true);
  });

  it('enables key generation once a public login server exists', async () => {
    renderPanel(CONFIGURED, []);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /generate join command/i })).toHaveProperty('disabled', false),
    );
    expect(screen.queryByText(/mesh isn't reachable yet/i)).toBeNull();
  });

  it('builds a join command containing the login server and the issued key', async () => {
    vi.mocked(meshApi.createPreauthKey).mockResolvedValue({ key: 'nodekey-abc123' });
    renderPanel(CONFIGURED, []);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /generate join command/i })).toHaveProperty('disabled', false),
    );
    (screen.getByRole('button', { name: /generate join command/i }) as HTMLButtonElement).click();

    await waitFor(() => expect(screen.getByText(/--login-server=/)).toBeDefined());
    const cmd = screen.getByText(/--login-server=/).textContent ?? '';
    expect(cmd).toContain('--login-server=https://mesh.example.com');
    expect(cmd).toContain('--authkey=nodekey-abc123');
  });

  it('renders devices with their mesh address, and marks offline ones', async () => {
    renderPanel(CONFIGURED, [
      { id: '1', name: 'gpu-box', ipAddresses: ['100.64.0.3'], online: true },
      { id: '2', name: 'old-laptop', ipAddresses: ['100.64.0.9'], online: false, lastSeen: '2026-01-01T00:00:00Z' },
    ]);
    await waitFor(() => expect(screen.getByText('gpu-box')).toBeDefined());
    expect(screen.getByText(/100\.64\.0\.3/)).toBeDefined();
    expect(screen.getByText(/last seen/i)).toBeDefined();
  });

  it('tells the user what to do when they have no machines yet', async () => {
    renderPanel(CONFIGURED, []);
    await waitFor(() => expect(screen.getByText(/no machines yet/i)).toBeDefined());
  });
});
