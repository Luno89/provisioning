import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Projects from './Projects';
import * as projectsApi from '../api/projects';
import * as localAgentsApi from '../api/local-agents';

vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjects: vi.fn(),
  listProjectRuns: vi.fn(),
  createProject: vi.fn(),
}));

vi.mock('../api/local-agents', async (importOriginal) => ({
  ...(await importOriginal<typeof localAgentsApi>()),
  listLocalAgentDevices: vi.fn(),
}));

vi.mock('../stores/socket', () => ({ useSocketEvent: vi.fn() }));

function renderProjects() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Projects clusters={[]} />
    </QueryClientProvider>,
  );
}

describe('Projects — where leaves run', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('offers registered local machines as an execution-target option, alongside the sandboxed default', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    expect(await screen.findByRole('option', { name: 'My Laptop' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sandboxed cluster (default)' })).toBeInTheDocument();
  });

  it('marks an offline device in its option label', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'Old Desktop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: false },
    ]);

    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    expect(await screen.findByRole('option', { name: 'Old Desktop (offline)' })).toBeInTheDocument();
  });

  it('submits the chosen device as executionTargetDeviceId', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({});

    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    await screen.findByRole('option', { name: 'My Laptop' });
    const [nameInput, giteaRepoInput] = screen.getAllByPlaceholderText('e.g. internal-dashboard');
    fireEvent.change(nameInput!, { target: { value: 'demo' } });
    fireEvent.change(giteaRepoInput!, { target: { value: 'demo' } });
    fireEvent.change(screen.getByDisplayValue('Sandboxed cluster (default)'), { target: { value: 'dev-1' } });

    fireEvent.click(screen.getByRole('button', { name: /register project/i }));

    await waitFor(() => expect(projectsApi.createProject).toHaveBeenCalled());
    const payload = vi.mocked(projectsApi.createProject).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.executionTargetDeviceId).toBe('dev-1');
    expect(payload.executionApproval).toBe('plan');
  });

  it('submits auto approval when the "require my approval" box is unchecked', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({});

    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    await screen.findByRole('option', { name: 'My Laptop' });
    const [nameInput, giteaRepoInput] = screen.getAllByPlaceholderText('e.g. internal-dashboard');
    fireEvent.change(nameInput!, { target: { value: 'demo' } });
    fireEvent.change(giteaRepoInput!, { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /require my approval/i }));

    fireEvent.click(screen.getByRole('button', { name: /register project/i }));

    await waitFor(() => expect(projectsApi.createProject).toHaveBeenCalled());
    const payload = vi.mocked(projectsApi.createProject).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.executionApproval).toBe('auto');
  });

  it('badges a project that requires approval', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{
      id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', appType: 'gitapp',
      createdAt: '2026-01-01T00:00:00Z', executionTarget: { kind: 'local-device', deviceId: 'dev-1' },
      executionApproval: 'plan',
    }]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderProjects();
    expect(await screen.findByText(/approval required/i)).toBeInTheDocument();
  });

  it('does not badge approval-required for a project running in auto mode', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{
      id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', appType: 'gitapp',
      createdAt: '2026-01-01T00:00:00Z', executionTarget: { kind: 'local-device', deviceId: 'dev-1' },
      executionApproval: 'auto',
    }]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderProjects();
    await screen.findByText('My Laptop');
    expect(screen.queryByText(/approval required/i)).not.toBeInTheDocument();
  });

  it('shows a hint instead of options when no machines are registered', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([]);

    renderProjects();
    fireEvent.click(screen.getByRole('button', { name: /new project/i }));

    expect(await screen.findByText(/no machines registered yet/i)).toBeInTheDocument();
  });

  it('badges a project whose leaves run on a local device, by name', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([{
      id: 'p1', name: 'demo', giteaOwner: 'acme', giteaRepo: 'demo', appType: 'gitapp',
      createdAt: '2026-01-01T00:00:00Z', executionTarget: { kind: 'local-device', deviceId: 'dev-1' },
    }]);
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderProjects();
    expect(await screen.findByText('My Laptop')).toBeInTheDocument();
  });
});
