import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AppDeployWizard from './index';
import * as modelsApi from '../../api/models';
import type { Cluster } from '../../types/cluster';

const modelsApiEmptyPage = {
  tags: [] as string[], page: 1, pageSize: 30, total: 0, totalPages: 1, sort: 'newest' as const,
};

vi.mock('../../api/models', async (importOriginal) => ({
  ...(await importOriginal<typeof modelsApi>()),
  useImageTags: vi.fn(() => ({ data: modelsApiEmptyPage, isLoading: false, isFetching: false })),
  useHfModelSize: vi.fn(() => ({ data: undefined, isFetching: false, isError: false })),
  useModelSearch: vi.fn(() => ({ data: [], isFetching: false })),
  useTabbyImageTags: vi.fn(() => ({ options: [], loading: false })),
  useHfBranches: vi.fn(() => ({ data: [], isFetching: false })),
}));

const clusters: Cluster[] = [
  { id: 'c1', name: 'dev', provider: 'k3d', status: 'healthy' },
  { id: 'gpu1', name: 'rig', provider: 'k3d', status: 'healthy', gpuEnabled: true },
];

const setup = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onDeploy = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <AppDeployWizard clusters={clusters} deployments={[]} onClose={onClose} onDeploy={onDeploy} />
    </QueryClientProvider>,
  );
  return { onClose, onDeploy, user: userEvent.setup() };
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the deploy wizard', () => {
  it('opens on the cluster step, offering the clusters it was given', () => {
    setup();
    expect(screen.getByRole('option', { name: /dev/ })).toBeDefined();
  });

  it('closes through its callback, not by reaching into App', () => {
    const { onClose } = setup();
    screen.getByLabelText('Close Wizard').click();
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from a clean slate every time it mounts', () => {
    setup();
    expect(screen.getByDisplayValue('Odoo-Production')).toBeDefined();
  });
});

describe('reaching the parent on deploy', () => {
  async function walkToConfirm(user: ReturnType<typeof userEvent.setup>, appType: string) {
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    for (let i = 0; i < 5; i++) {
      const next = screen.queryByRole('button', { name: /^Next/ });
      if (!next) break;
      await user.click(next);
    }
  }

  it('calls onDeploy with the assembled payload when Initiate Deployment is clicked', async () => {
    const { onDeploy, user } = setup();
    await walkToConfirm(user, 'wordpress');

    const initiate = screen.getByRole('button', { name: /Initiate Deployment/ });
    await user.click(initiate);

    expect(onDeploy).toHaveBeenCalledTimes(1);
    const payload = onDeploy.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.appType).toBe('wordpress');
    expect(payload.clusterId).toBe('c1');
    expect(payload.pgRepo).toBeTruthy();
    expect(payload.pgTag).toBeTruthy();
  });
});

describe('the model step for vLLM and TabbyAPI', () => {
  const useModelSearch = vi.mocked(modelsApi.useModelSearch);

  async function walkToModelStep(user: ReturnType<typeof userEvent.setup>, appType: string) {
    await user.selectOptions(screen.getByLabelText(/application type/i), appType);
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'gpu1');
    await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: /^Next/ }));
  }

  it.each(['vllm', 'tabbyapi'])('runs the model search on the step that renders it (%s)', async (appType) => {
    const { user } = setup();
    await walkToModelStep(user, appType);

    expect(screen.getByPlaceholderText(/qwen|llama|mistral/i)).toBeInTheDocument();
    expect(useModelSearch).toHaveBeenLastCalledWith(appType, '', true);
  });

  it('lists the models the search returns', async () => {
    useModelSearch.mockReturnValue({
      data: [{ id: 'turboderp/Qwen3-27B-exl3', downloads: 42 }], isFetching: false,
    } as unknown as ReturnType<typeof modelsApi.useModelSearch>);

    const { user } = setup();
    await walkToModelStep(user, 'tabbyapi');

    expect(screen.getByText('Qwen3-27B-exl3')).toBeInTheDocument();
    expect(screen.getByText(/turboderp\/Qwen3-27B-exl3 · 42 downloads/)).toBeInTheDocument();
  });

  it('leaves the search idle for app types that have no model step', async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/application type/i), 'jellyfin');
    await user.selectOptions(screen.getByLabelText(/target cluster/i), 'c1');
    await user.click(screen.getByRole('button', { name: /^Next/ }));
    await user.click(screen.getByRole('button', { name: /^Next/ }));

    expect(useModelSearch).toHaveBeenLastCalledWith('jellyfin', '', false);
  });
});
