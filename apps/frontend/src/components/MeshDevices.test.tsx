import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MeshDevices from './MeshDevices';
import * as meshApi from '../api/mesh';
import * as localAgentsApi from '../api/local-agents';

vi.mock('../api/mesh', async (importOriginal) => ({
  ...(await importOriginal<typeof meshApi>()),
  getMeshConfig: vi.fn(),
  listMeshDevices: vi.fn(),
  createPreauthKey: vi.fn(),
  deleteMeshDevice: vi.fn(),
}));

vi.mock('../api/local-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof localAgentsApi>()),
  listLocalAgentDevices: vi.fn(),
  createLocalAgentDevice: vi.fn(),
  deleteLocalAgentDevice: vi.fn(),
}));

const renderPanel = (config: unknown, devices: unknown[], localAgents: unknown[] = []) => {
  vi.mocked(meshApi.getMeshConfig).mockResolvedValue(config as never);
  vi.mocked(meshApi.listMeshDevices).mockResolvedValue(devices as never);
  vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue(localAgents as never);
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

describe('local execution agents', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('disables registering a machine until both fields are filled', async () => {
    renderPanel(CONFIGURED, []);
    await waitFor(() => expect(screen.getByPlaceholderText(/Name, e\.g\. My Laptop/)).toBeDefined());

    const button = screen.getByRole('button', { name: /generate command/i });
    expect(button).toHaveProperty('disabled', true);
  });

  it('registers a machine and shows the run command with its token once', async () => {
    vi.mocked(localAgentsApi.createLocalAgentDevice).mockResolvedValue({
      id: 'dev-1', name: 'My Laptop', rootDir: '/home/me/koala-work', token: 'secret-token-123',
    });
    renderPanel(CONFIGURED, []);

    await waitFor(() => expect(screen.getByPlaceholderText(/Name, e\.g\. My Laptop/)).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText(/Name, e\.g\. My Laptop/), { target: { value: 'My Laptop' } });
    fireEvent.change(screen.getByPlaceholderText(/Root directory/), { target: { value: '/home/me/koala-work' } });

    const button = screen.getByRole('button', { name: /generate command/i });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText(/secret-token-123/)).toBeDefined());
    expect(screen.getByText(/KOALA_ROOT_DIR=\/home\/me\/koala-work/)).toBeDefined();
  });

  it('renders registered local agents with their online status', async () => {
    renderPanel(CONFIGURED, [], [
      { id: 'dev-1', name: 'My Laptop', rootDir: '/home/me/work', createdAt: '2026-01-01T00:00:00Z', online: true },
      { id: 'dev-2', name: 'Old Desktop', rootDir: '/home/me/other', createdAt: '2026-01-01T00:00:00Z', online: false, lastSeenAt: '2026-01-01T00:00:00Z' },
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText('Old Desktop')).toBeDefined();
    expect(screen.getByText(/last seen/i)).toBeDefined();
  });

  it('badges an online device running in a Docker container as isolated', async () => {
    renderPanel(CONFIGURED, [], [
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true, containerMode: true },
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText(/isolated/i)).toBeDefined();
    expect(screen.queryByText(/raw access/i)).toBeNull();
  });

  it('badges an online device with no Docker as raw access', async () => {
    renderPanel(CONFIGURED, [], [
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true, containerMode: false },
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText(/raw access/i)).toBeDefined();
  });

  it('shows no mode badge for an offline device', async () => {
    renderPanel(CONFIGURED, [], [
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: false },
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.queryByText(/isolated/i)).toBeNull();
    expect(screen.queryByText(/raw access/i)).toBeNull();
  });
});
