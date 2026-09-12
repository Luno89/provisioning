import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NewProjectDialog } from './NewProjectDialog.js';
import * as projectsApi from '../../api/projects.js';
import * as localAgentsApi from '../../api/local-agents.js';

vi.mock('../../api/projects.js', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  createProject: vi.fn(),
}));

vi.mock('../../api/local-agents.js', async (importOriginal) => ({
  ...(await importOriginal<typeof localAgentsApi>()),
  listLocalAgentDevices: vi.fn(),
}));

function renderDialog(onCreated = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewProjectDialog clusters={[]} onClose={vi.fn()} onCreated={onCreated} />
    </QueryClientProvider>,
  );
}

describe('NewProjectDialog — where leaves run', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('offers registered local machines as an execution-target option, alongside the sandboxed default', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderDialog();

    expect(await screen.findByRole('option', { name: 'My Laptop' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Sandboxed cluster (default)' })).toBeInTheDocument();
  });

  it('marks an offline device in its option label', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'Old Desktop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: false },
    ]);

    renderDialog();

    expect(await screen.findByRole('option', { name: 'Old Desktop (offline)' })).toBeInTheDocument();
  });

  it('submits the chosen device as executionTargetDeviceId', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({ id: 'p1' });

    renderDialog();
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
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({ id: 'p1' });

    renderDialog();
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

  it('hides the Gitea repository field once a local machine is chosen', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);

    renderDialog();
    await screen.findByRole('option', { name: 'My Laptop' });
    expect(screen.getAllByPlaceholderText('e.g. internal-dashboard')).toHaveLength(2);

    fireEvent.change(screen.getByDisplayValue('Sandboxed cluster (default)'), { target: { value: 'dev-1' } });

    expect(screen.queryByText(/gitea repository name/i)).not.toBeInTheDocument();
    expect(screen.getByText(/subfolder on that machine/i)).toBeInTheDocument();
  });

  it('does not require a Gitea repo when creating a project scoped to a local machine', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([
      { id: 'dev-1', name: 'My Laptop', rootDir: '/x', createdAt: '2026-01-01T00:00:00Z', online: true },
    ]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({ id: 'p1' });

    renderDialog();
    await screen.findByRole('option', { name: 'My Laptop' });
    const [nameInput] = screen.getAllByPlaceholderText('e.g. internal-dashboard');
    fireEvent.change(nameInput!, { target: { value: 'second-thing' } });
    fireEvent.change(screen.getByDisplayValue('Sandboxed cluster (default)'), { target: { value: 'dev-1' } });
    fireEvent.change(screen.getByPlaceholderText(/leave blank for the machine's root/i), { target: { value: 'apps/two' } });

    fireEvent.click(screen.getByRole('button', { name: /register project/i }));

    await waitFor(() => expect(projectsApi.createProject).toHaveBeenCalled());
    const payload = vi.mocked(projectsApi.createProject).mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.executionTargetDeviceId).toBe('dev-1');
    expect(payload.executionTargetPath).toBe('apps/two');
    expect(payload.giteaRepo).toBeUndefined();
    expect(payload.createRepo).toBeUndefined();
  });

  it('shows a hint instead of options when no machines are registered', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([]);

    renderDialog();

    expect(await screen.findByText(/no machines registered yet/i)).toBeInTheDocument();
  });

  it('calls onCreated with the new project id', async () => {
    vi.mocked(localAgentsApi.listLocalAgentDevices).mockResolvedValue([]);
    vi.mocked(projectsApi.createProject).mockResolvedValue({ id: 'p1' });
    const onCreated = vi.fn();

    renderDialog(onCreated);
    const [nameInput, giteaRepoInput] = screen.getAllByPlaceholderText('e.g. internal-dashboard');
    fireEvent.change(nameInput!, { target: { value: 'demo' } });
    fireEvent.change(giteaRepoInput!, { target: { value: 'demo' } });
    fireEvent.click(screen.getByRole('button', { name: /register project/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('p1'));
  });
});
