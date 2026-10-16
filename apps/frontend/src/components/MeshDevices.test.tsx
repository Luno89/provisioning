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
  createMachineJoinCode: vi.fn(),
  setMachineAgents: vi.fn(),
  installMachineAdapter: vi.fn(),
  deleteLocalAgentDevice: vi.fn(),
}));

const machine = (overrides: Record<string, unknown> = {}) => ({
  id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true, agents: [], manualAgents: [], ...overrides,
});

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

  it('gives the one-line command that adds a machine, and says how long it works', async () => {
    vi.mocked(localAgentsApi.createMachineJoinCode).mockResolvedValue({
      code: 'abc', command: 'curl -fsSL https://koala.example/machine.sh | sh -s -- abc', expiresAt: '2026-10-15T13:00:00Z',
    });
    renderPanel(CONFIGURED, []);
    fireEvent.click(await screen.findByRole('button', { name: /get the command/i }));
    expect(await screen.findByText('curl -fsSL https://koala.example/machine.sh | sh -s -- abc')).toBeDefined();
    expect(screen.getByText(/It works once, until/)).toBeDefined();
  });

  it('shows the coding agents each machine found, and installs an adapter one needs', async () => {
    vi.mocked(localAgentsApi.installMachineAdapter).mockResolvedValue({ ok: true, output: 'added 1 package' });
    renderPanel(CONFIGURED, [], [machine({
      agentsAt: '2026-10-15T12:00:00Z',
      agents: [
        { id: 'gemini', title: 'Gemini CLI', state: 'ready', source: 'found', command: '/usr/bin/gemini', args: ['--acp'], name: 'Gemini CLI', version: '0.61.0', signIn: ['Log in with Google'] },
        { id: 'claude', title: 'Claude Code', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/claude-agent-acp', reason: 'Claude Code is installed, but it speaks ACP through @agentclientprotocol/claude-agent-acp, which is not installed' },
      ],
    })]);
    expect(await screen.findByText('Gemini CLI')).toBeDefined();
    expect(screen.getByText('0.61.0')).toBeDefined();
    expect(screen.getByText('/usr/bin/gemini --acp')).toBeDefined();
    expect(screen.getByText(/Signs in with Log in with Google/)).toBeDefined();
    expect(screen.getByText('needs its adapter')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /install adapter/i }));
    await waitFor(() => expect(localAgentsApi.installMachineAdapter).toHaveBeenCalledWith('dev-1', 'claude'));
    expect(await screen.findByText(/added 1 package/)).toBeDefined();
  });

  it('cannot install on a machine that is not connected', async () => {
    renderPanel(CONFIGURED, [], [machine({ online: false, agentsAt: '2026-10-15T12:00:00Z', agents: [{ id: 'codex', title: 'Codex', state: 'needs-adapter', source: 'found', adapter: '@agentclientprotocol/codex-acp' }] })]);
    expect(await screen.findByRole('button', { name: /install adapter/i })).toHaveProperty('disabled', true);
  });

  it('adds an agent by hand to the ones the machine already has', async () => {
    vi.mocked(localAgentsApi.setMachineAgents).mockResolvedValue(machine() as never);
    renderPanel(CONFIGURED, [], [machine({ manualAgents: [{ id: 'goose', command: 'goose', args: ['acp'] }] })]);
    fireEvent.click(await screen.findByText(/add an agent by hand/i));
    fireEvent.change(screen.getByLabelText('Agent id'), { target: { value: 'antigravity' } });
    fireEvent.change(screen.getByLabelText('Agent name'), { target: { value: 'Antigravity' } });
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: '/opt/agy/agy_acp_server.par' } });
    fireEvent.change(screen.getByLabelText('Arguments'), { target: { value: '--uid=' } });
    fireEvent.click(screen.getByRole('button', { name: /add it/i }));
    await waitFor(() => expect(localAgentsApi.setMachineAgents).toHaveBeenCalledWith('dev-1', [
      { id: 'goose', command: 'goose', args: ['acp'] },
      { id: 'antigravity', title: 'Antigravity', command: '/opt/agy/agy_acp_server.par', args: ['--uid='] },
    ]));
  });

  it('says a machine found no agents, once it has looked', async () => {
    renderPanel(CONFIGURED, [], [machine({ agentsAt: '2026-10-15T12:00:00Z' })]);
    expect(await screen.findByText('None found on this machine.')).toBeDefined();
  });

  it('renders registered local agents with their online status', async () => {
    renderPanel(CONFIGURED, [], [
      machine({ rootDir: '/home/me/work' }),
      machine({ id: 'dev-2', name: 'Old Desktop', rootDir: '/home/me/other', online: false, lastSeenAt: '2026-01-01T00:00:00Z' }),
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText('Old Desktop')).toBeDefined();
    expect(screen.getByText(/last seen/i)).toBeDefined();
  });

  it('badges an online device running in a Docker container as isolated', async () => {
    renderPanel(CONFIGURED, [], [
      machine({ containerMode: true }),
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText(/isolated/i)).toBeDefined();
    expect(screen.queryByText(/raw access/i)).toBeNull();
  });

  it('badges an online device with no Docker as raw access', async () => {
    renderPanel(CONFIGURED, [], [
      machine({ containerMode: false }),
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.getByText(/raw access/i)).toBeDefined();
  });

  it('shows no mode badge for an offline device', async () => {
    renderPanel(CONFIGURED, [], [
      machine({ online: false }),
    ]);

    await waitFor(() => expect(screen.getByText('My Laptop')).toBeDefined());
    expect(screen.queryByText(/isolated/i)).toBeNull();
    expect(screen.queryByText(/raw access/i)).toBeNull();
  });
});
