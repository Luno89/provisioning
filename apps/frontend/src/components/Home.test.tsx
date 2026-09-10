import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Home from './Home';
import * as projectsApi from '../api/projects';

vi.mock('../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof projectsApi>()),
  listProjects: vi.fn(),
  listProjectRuns: vi.fn(),
}));

vi.mock('../api/grove', () => ({
  cancelLeaf: vi.fn(),
  recheckLeaf: vi.fn(),
}));

const tree = { id: 't-1', name: 'demo', goal: 'Ship it', projectIds: ['proj-1'] };

const project = {
  id: 'proj-1',
  name: 'demo',
  giteaOwner: 'acme',
  giteaRepo: 'demo',
  status: 'running',
  autoDeployOnBuild: true,
};

const runs = [
  {
    id: 'run-2', projectId: 'proj-1', commitSha: 'def45678', ref: 'main', status: 'succeeded',
    imageTag: 'registry.local/demo:def45678', startedAt: '2026-01-02T00:00:00Z', finishedAt: '2026-01-02T00:01:00Z',
    commitMessage: 'Add the second feature', deploymentId: 'demo', promotedAt: '2026-01-02T00:02:00Z',
  },
  {
    id: 'run-1', projectId: 'proj-1', commitSha: 'abc12345', ref: 'main', status: 'succeeded',
    imageTag: 'registry.local/demo:abc12345', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z',
    commitMessage: 'Initial commit',
  },
];

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Home
        leaves={[]}
        branches={[]}
        trees={[tree]}
        tree={tree}
        packNames={{}}
        onStart={vi.fn()}
        onOpenLeaf={vi.fn()}
        onOpenTree={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe('Home deployment & change log', () => {
  it('renders every past run with its commit message, not just the latest', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project]);
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue(runs);

    renderHome();

    expect(await screen.findByText('Deployment & Change Log')).toBeInTheDocument();
    expect(await screen.findByText('Add the second feature')).toBeInTheDocument();
    expect(screen.getByText('Initial commit')).toBeInTheDocument();
  });

  it('marks the promoted, currently-running deployment as Live', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project]);
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue(runs);

    renderHome();

    await screen.findByText('Add the second feature');
    expect(screen.getAllByText('● Live')).toHaveLength(1);
  });

  it('stays out of the way when the project has no runs yet', async () => {
    vi.mocked(projectsApi.listProjects).mockResolvedValue([project]);
    vi.mocked(projectsApi.listProjectRuns).mockResolvedValue([]);

    renderHome();

    await screen.findByText(project.giteaOwner + '/' + project.giteaRepo);
    expect(screen.queryByText('Deployment & Change Log')).not.toBeInTheDocument();
  });
});
